// PGP decryption during indexing: detection, decryption with an ephemeral test key,
// protected headers, inline PGP, encrypted attachments and the failure paths.
//
// The GPG homes used here live in temp directories and are removed afterwards; the user's
// keyring is never touched (see test/fixtures/pgp.js).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { findArmored, isPgpMime, isPgpAttachment, stripCryptoSuffix, decryptGpg, hasGpg, countSecretKeys, ARMOR_BEGIN } from "../../src/pgp.js";
import { parseRawMessage } from "../../src/mime.js";
import { extractAttachmentText } from "../../src/attachments.js";
import { openDb, markForReparse, REPARSE_SETS } from "../../src/db.js";
import { buildMessage, buildPdf } from "../fixtures/mime-builder.js";
import { makeGpgHome, encrypt, buildPgpMime, buildInlinePgp } from "../fixtures/pgp.js";

const skip = hasGpg() ? false : "gpg is not installed";
const me = { name: "Anna Schmidt", email: "anna@example.com" };
const bob = { name: "Jürgen Müller", email: "J.Mueller@Example.com" };
const outer = { from: "Jürgen Müller <j.mueller@example.com>", to: "anna@example.com", subject: "pEp", date: "Fri, 2 Jan 2026 10:00:00 +0000", messageId: "outer@example.com" };

let keyring; // home with the test key
let empty; // home without any key
before(() => {
  keyring = makeGpgHome();
  empty = makeGpgHome({ withKey: false });
});
after(() => {
  keyring?.cleanup();
  empty?.cleanup();
});

/** Run fn with GNUPGHOME set to `home` (the production code inherits the environment). */
async function withHome(home, fn) {
  const prev = process.env.GNUPGHOME;
  process.env.GNUPGHOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = prev;
  }
}

function innerMessage(extra = {}) {
  return buildMessage({
    from: bob,
    to: [me],
    subject: "Vertrag v3 Geheimnis",
    date: Date.UTC(2026, 0, 2),
    messageId: "inner@example.com",
    text: "Der Klartext ist Geheimnis XYZ.\n",
    ...extra,
  });
}

// ─── Detection helpers ───────────────────────────────────────────────

test("findArmored: the armor block is found, nothing else matches", () => {
  const block = `${ARMOR_BEGIN}\n\nabc\n=xyz\n-----END PGP MESSAGE-----`;
  assert.equal(findArmored(`before\n${block}\nafter`), block);
  assert.equal(findArmored("no encryption here"), null);
  assert.equal(findArmored(`${ARMOR_BEGIN}\nno end marker`), null);
});

test("isPgpMime / isPgpAttachment / stripCryptoSuffix", () => {
  assert.ok(isPgpMime('multipart/encrypted; protocol="application/pgp-encrypted"; boundary="x"'));
  assert.ok(!isPgpMime("multipart/mixed"));
  assert.ok(isPgpAttachment("geheim.pdf.gpg"));
  assert.ok(isPgpAttachment("daten.pgp"));
  assert.ok(isPgpAttachment("blob", "application/pgp-encrypted"));
  assert.ok(isPgpAttachment("blob", "application/octet-stream", "-----BEGIN PGP MESSAGE-----\nabc"));
  assert.ok(!isPgpAttachment("rechnung.pdf", "application/pdf", "%PDF-1.4"));
  assert.equal(stripCryptoSuffix("geheim.pdf.gpg"), "geheim.pdf");
  assert.equal(stripCryptoSuffix("geheim.asc"), "geheim");
});

test("decryptGpg: success and classified failures never throw", { skip }, async () => {
  const cipher = encrypt("Klartext 42", keyring.home);
  const ok = await withHome(keyring.home, () => decryptGpg(cipher));
  assert.ok(ok.ok);
  assert.equal(ok.buf.toString("utf8").trim(), "Klartext 42");

  const noKey = await withHome(empty.home, () => decryptGpg(cipher));
  assert.ok(!noKey.ok);
  assert.match(noKey.error, /secret key/);

  const corrupt = await withHome(keyring.home, () => decryptGpg(`${ARMOR_BEGIN}\ngarbage\n-----END PGP MESSAGE-----`));
  assert.ok(!corrupt.ok);
  assert.match(corrupt.error, /could not be decrypted/);
});

test("hasGpg / countSecretKeys", { skip }, async () => {
  assert.ok(hasGpg());
  // Counted inside the ephemeral home: the real keyring is never inspected.
  const n = await withHome(keyring.home, () => countSecretKeys());
  assert.equal(n, 1);
});

// ─── PGP/MIME ────────────────────────────────────────────────────────

test("PGP/MIME: decrypted body and protected headers are indexed", { skip }, async () => {
  const cipher = encrypt(innerMessage(), keyring.home);
  const raw = buildPgpMime(null, cipher, outer);
  const p = await withHome(keyring.home, () => parseRawMessage(raw, { decryptPgp: true }));
  assert.equal(p.encrypted, true);
  assert.equal(p.pgpState, "decrypted");
  assert.equal(p.subject, "Vertrag v3 Geheimnis");
  assert.equal(p.subjectMismatch, true, "outer placeholder subject differs");
  assert.match(p.body, /Geheimnis XYZ/);
  assert.equal(p.mid, "outer@example.com", "transport headers stay authoritative");
  assert.equal(p.from.addr, "j.mueller@example.com", "protected From wins");
  assert.equal(p.to[0].addr, "anna@example.com");
});

test("PGP/MIME: matching or empty outer Subject is not a mismatch", { skip }, async () => {
  const cipher = encrypt(innerMessage(), keyring.home);
  const p = await withHome(keyring.home, () =>
    parseRawMessage(buildPgpMime(null, cipher, { ...outer, subject: "Vertrag v3 Geheimnis" }), { decryptPgp: true })
  );
  assert.equal(p.subjectMismatch, false);
  const p2 = await withHome(keyring.home, () =>
    parseRawMessage(buildPgpMime(null, cipher, { ...outer, subject: "" }), { decryptPgp: true })
  );
  assert.equal(p2.subjectMismatch, false);
  assert.equal(p2.subject, "Vertrag v3 Geheimnis");
});

test("PGP/MIME: attachments inside the encrypted part are extracted", { skip }, async () => {
  const inner = innerMessage({
    text: "Anbei die Rechnung.\n",
    attachments: [{ filename: "rechnung.pdf", contentType: "application/pdf", content: buildPdf(["Rechnung 42, Betrag 99 EUR"]) }],
  });
  const cipher = encrypt(inner, keyring.home);
  const p = await withHome(keyring.home, () => parseRawMessage(buildPgpMime(null, cipher, outer), { decryptPgp: true }));
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].filename, "rechnung.pdf");
  assert.match(p.attachments[0].text, /Rechnung 42/);
});

test("PGP/MIME: missing key marks the message without breaking parsing", { skip }, async () => {
  const cipher = encrypt(innerMessage(), keyring.home);
  const raw = buildPgpMime(null, cipher, outer);
  const p = await withHome(empty.home, () => parseRawMessage(raw, { decryptPgp: true }));
  assert.equal(p.encrypted, true);
  assert.equal(p.pgpState, "failed");
  assert.match(p.pgpError, /secret key/);
  assert.equal(p.body, "");
  assert.notEqual(p.mid, "", "transport data is still parsed");
});

test("PGP/MIME: corrupt payload fails cleanly", { skip }, async () => {
  const raw = buildPgpMime(null, `${ARMOR_BEGIN}\ngarbage\n-----END PGP MESSAGE-----`, outer);
  const p = await withHome(keyring.home, () => parseRawMessage(raw, { decryptPgp: true }));
  assert.equal(p.pgpState, "failed");
  assert.match(p.pgpError, /could not be decrypted/);
});

test("index.decryptPgp: false marks the message but never calls gpg", { skip }, async () => {
  const cipher = encrypt(innerMessage(), keyring.home);
  const raw = buildPgpMime(null, cipher, outer);
  const p = await withHome(empty.home, () => parseRawMessage(raw, {}));
  assert.equal(p.encrypted, true, "still discoverable with is:encrypted");
  assert.equal(p.pgpState, undefined);
  assert.equal(p.body, "");
});

test("gpg missing: message is marked, error is clear", { skip }, async () => {
  const cipher = encrypt(innerMessage(), keyring.home);
  const raw = buildPgpMime(null, cipher, outer);
  process.env.DONNER_NO_GPG = "1";
  let p;
  try {
    p = await parseRawMessage(raw, { decryptPgp: true });
  } finally {
    delete process.env.DONNER_NO_GPG;
  }
  assert.equal(p.pgpState, "failed");
  assert.match(p.pgpError, /gpg is not installed/);
});

// ─── Inline PGP ──────────────────────────────────────────────────────

test("inline PGP: the armor block is replaced by its plaintext", { skip }, async () => {
  const cipher = encrypt("Der Termin ist am Freitag um 9.\n--\nSignatur", keyring.home);
  const raw = buildInlinePgp(cipher, outer);
  const p = await withHome(keyring.home, () => parseRawMessage(raw, { decryptPgp: true }));
  assert.equal(p.encrypted, true);
  assert.equal(p.pgpState, "decrypted");
  assert.match(p.body, /Freitag um 9/);
  assert.ok(!p.body.includes("BEGIN PGP"), "armor is never indexed");
});

test("inline PGP: without decryption the armor block is dropped, the flag stays", { skip }, async () => {
  const cipher = encrypt("Geheim", keyring.home);
  const p = await withHome(empty.home, () => parseRawMessage(buildInlinePgp(cipher, outer), {}));
  assert.equal(p.encrypted, true);
  assert.equal(p.pgpState, undefined);
  assert.ok(!p.body.includes("BEGIN PGP"));
});

// ─── Encrypted attachments ───────────────────────────────────────────

test("encrypted attachment: .pdf.gpg is decrypted and extracted like a PDF", { skip }, async () => {
  const pdf = buildPdf(["Rechnung 42, Betrag 99 EUR"]);
  const cipher = encrypt(pdf, keyring.home);
  const r = await withHome(keyring.home, () =>
    extractAttachmentText({ filename: "rechnung.pdf.gpg", mimeType: "application/octet-stream", content: Buffer.from(cipher) }, { decryptPgp: true })
  );
  assert.equal(r.state, "extracted");
  assert.match(r.text, /Rechnung 42/);
});

test("encrypted attachment: a signature file is not treated as ciphertext", { skip }, async () => {
  const sig = Buffer.from("-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n");
  const r = await withHome(keyring.home, () =>
    extractAttachmentText({ filename: "mail.txt.asc", mimeType: "text/plain", content: sig }, { decryptPgp: true })
  );
  assert.notEqual(r.state, "error");
});

test("encrypted attachment: missing key records an error state", { skip }, async () => {
  const cipher = encrypt(Buffer.from("Geheim"), keyring.home);
  const r = await withHome(empty.home, () =>
    extractAttachmentText({ filename: "daten.gpg", mimeType: "application/octet-stream", content: Buffer.from(cipher) }, { decryptPgp: true })
  );
  assert.equal(r.state, "error");
  assert.match(r.error, /secret key/);
});

// ─── Re-extraction of stored messages ────────────────────────────────

test("reparse set pgp: marks undecrypted messages and resets the retry budget", () => {
  const db = openDb(":memory:");
  try {
    const ins = db.prepare("INSERT INTO messages(mid, folder_id, body, content_state, encrypted, pgp_state, pgp_attempts) VALUES(?,?,?,?,?,?,?)");
    const failed = ins.run("a@b", "f", "", "full", 1, "failed", 3).lastInsertRowid;
    const done = ins.run("c@d", "f", "Klartext", "full", 1, "decrypted", 0).lastInsertRowid;
    const plain = ins.run("e@f", "f", "Hallo", "full", 0, null, 0).lastInsertRowid;
    assert.ok(REPARSE_SETS.pgp.includes("encrypted"));

    const n = markForReparse(db, ["pgp"]);
    assert.equal(n, 1);
    const row = db.prepare("SELECT content_state, pgp_attempts FROM messages WHERE id = ?").get(failed);
    assert.equal(row.content_state, "pending");
    assert.equal(row.pgp_attempts, 0, "fresh retry budget after --reparse pgp");
    assert.equal(db.prepare("SELECT content_state FROM messages WHERE id = ?").get(done).content_state, "full");
    assert.equal(db.prepare("SELECT content_state FROM messages WHERE id = ?").get(plain).content_state, "full");
  } finally {
    db.close();
  }
});
