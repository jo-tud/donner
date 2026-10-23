// PGP decryption during indexing: detection, decryption with an ephemeral test key,
// protected headers, inline PGP, encrypted attachments and the failure paths.
//
// The GPG homes used here live in temp directories and are removed afterwards; the user's
// keyring is never touched (see test/fixtures/pgp.js).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { findArmored, isPgpMime, isPgpAttachment, stripCryptoSuffix, decryptGpg, hasGpg, countSecretKeys, ARMOR_BEGIN } from "../../src/pgp.js";
import { parseRawMessage } from "../../src/mime.js";
import { extractAttachmentText } from "../../src/attachments.js";
import { openDb, markForReparse, REPARSE_SETS, purgeDecrypted, countDecrypted } from "../../src/db.js";
import { decryptForAccount, parseDecryptPgpSpec, loadConfig, saveIndexConfig } from "../../src/config.js";
import { compileQuery } from "../../src/query.js";
import { buildMessage, buildPdf } from "../fixtures/mime-builder.js";
import { makeGpgHome, encrypt, signEncrypt, fingerprint, buildPgpMime, buildInlinePgp } from "../fixtures/pgp.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const me = { name: "Anna Schmidt", email: "anna@example.com" };
const bob = { name: "Jürgen Müller", email: "J.Mueller@Example.com" };
const outer = { from: "Jürgen Müller <j.mueller@example.com>", to: "anna@example.com", subject: "pEp", date: "Fri, 2 Jan 2026 10:00:00 +0000", messageId: "outer@example.com" };

// The gpg tests need a working gpg (e.g. Windows CI has none) and a throwaway keyring. The
// fixtures are set up at load time so that a setup failure becomes a skip, not a broken file.
let keyring = null; // home with the test key
let empty = null; // home without any key
let setupError = null;
if (hasGpg()) {
  try {
    keyring = makeGpgHome();
    empty = makeGpgHome({ withKey: false });
  } catch (err) {
    setupError = err;
    keyring?.cleanup();
    empty?.cleanup();
    keyring = empty = null;
  }
}
const skip = keyring ? false : hasGpg() ? `gpg test key setup failed: ${setupError?.message || setupError}` : "gpg is not installed";
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

test("decryptGpg: signed by a sender whose key is not in the keyring still decrypts", { skip }, async () => {
  // gpg exits with 2 when it cannot check the signature; the decryption itself succeeded.
  const signer = makeGpgHome();
  try {
    const cipher = signEncrypt("Signiert und verschluesselt", signer.home, keyring.home);
    const r = await withHome(keyring.home, () => decryptGpg(cipher));
    assert.ok(r.ok, r.error);
    assert.equal(r.buf.toString("utf8").trim(), "Signiert und verschluesselt");
  } finally {
    signer.cleanup();
  }
});

test("decryptGpg: a stranger's signed mail triggers no keyserver lookup and no key import", { skip }, async () => {
  // The user's gpg.conf may enable auto-key-retrieve / auto-key-import. Decrypting a mail
  // must not contact a keyserver (a read receipt for the sender) or change the keyring.
  const recipient = makeGpgHome();
  const signer = makeGpgHome();
  let connections = 0;
  const server = createServer((sock) => {
    connections++;
    sock.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const cipher = signEncrypt("Hallo von einem Fremden", signer.home, recipient.home);
    const signerFpr = fingerprint(signer.home);
    writeFileSync(join(recipient.home, "gpg.conf"), `auto-key-retrieve\nauto-key-import\nkeyserver hkp://127.0.0.1:${server.address().port}\n`);
    const r = await withHome(recipient.home, () => decryptGpg(cipher));
    assert.ok(r.ok, r.error);
    assert.equal(r.buf.toString("utf8").trim(), "Hallo von einem Fremden");
    assert.equal(connections, 0, "no keyserver lookup");
    const known = spawnSync("gpg", ["--batch", "--list-keys", signerFpr], { env: { ...process.env, GNUPGHOME: recipient.home }, stdio: "ignore" });
    assert.notEqual(known.status, 0, "the signer's key was not imported");
  } finally {
    server.close();
    recipient.cleanup();
    signer.cleanup();
  }
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

// ─── Opt-in per account (index.decryptPgp) ──────────────────────────

test("decryptForAccount: true/false/list, account names and ids", () => {
  const firma = { id: "account1", name: "Firma" };
  const privat = { id: "account2", name: "Privat" };
  assert.equal(decryptForAccount(true, privat), true);
  assert.equal(decryptForAccount(false, privat), false);
  assert.equal(decryptForAccount(null, privat), false, "undecided behaves like off");
  assert.equal(decryptForAccount([], privat), false, "an empty list decrypts nothing");
  assert.equal(decryptForAccount(["Firma"], firma), true, "name, case-insensitive");
  assert.equal(decryptForAccount(["firma"], firma), true);
  assert.equal(decryptForAccount(["account1"], firma), true, "id, exact");
  assert.equal(decryptForAccount(["Firma"], privat), false);
  assert.equal(decryptForAccount(["Privat"], privat), true);
});

test("parseDecryptPgpSpec: all/none/account list, validated against known accounts", () => {
  const names = ["Firma", "Privat"];
  assert.equal(parseDecryptPgpSpec("all", names), true);
  assert.equal(parseDecryptPgpSpec("ja", names), true);
  assert.equal(parseDecryptPgpSpec("", names), false);
  assert.equal(parseDecryptPgpSpec("none", names), false);
  assert.equal(parseDecryptPgpSpec("nein", names), false);
  assert.deepEqual(parseDecryptPgpSpec("Firma", names), ["Firma"]);
  assert.deepEqual(parseDecryptPgpSpec("firma, Privat", names), ["firma", "Privat"]);
  assert.equal(parseDecryptPgpSpec("Firma, Unbekannt", names), null, "unknown accounts are rejected");
  assert.deepEqual(parseDecryptPgpSpec("WasAuchImmer", []), ["WasAuchImmer"], "without a known list, names are taken as-is");
});

test("index.decryptPgp in the config file is recognised as an explicit decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "donner-cfg-"));
  const prev = process.env.DONNER_CONFIG_DIR;
  process.env.DONNER_CONFIG_DIR = dir;
  try {
    assert.equal(loadConfig().sources.decryptPgp, "defaults", "unset by default");
    saveIndexConfig({ decryptPgp: ["Firma"] });
    const cfg = loadConfig();
    assert.deepEqual(cfg.index.decryptPgp, ["Firma"]);
    assert.equal(cfg.sources.decryptPgp, "config");
  } finally {
    if (prev === undefined) delete process.env.DONNER_CONFIG_DIR;
    else process.env.DONNER_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── hideEncrypted: encrypted mail out of default results ───────────

test("hideEncrypted: only encrypted mail without indexed content is hidden, explicit is:encrypted wins", () => {
  const hidden = compileQuery("rechnung", { hideEncrypted: true });
  assert.ok(hidden.where.includes("(m.encrypted = 0 OR m.pgp_state = 'decrypted')"));
  const shown = compileQuery("rechnung", {});
  assert.ok(!shown.where.some((w) => w.includes("encrypted")));
  const explicit = compileQuery("rechnung is:encrypted", { hideEncrypted: true });
  assert.ok(!explicit.where.some((w) => w.includes("pgp_state")), "the query asked for encrypted mail");
  const negated = compileQuery("rechnung -is:encrypted", { hideEncrypted: true });
  assert.ok(!negated.where.some((w) => w.includes("pgp_state")), "already excluded explicitly");
});

test("hideEncrypted: decrypted mail stays visible, undecrypted and purged mail does not", () => {
  const db = openDb(":memory:");
  try {
    const ins = db.prepare("INSERT INTO messages(mid, folder_id, subject, body, content_state, encrypted, pgp_state) VALUES(?,?,?,?,?,?,?)");
    ins.run("a@b", "f", "Vertrag", "Klartext", "full", 1, "decrypted");
    ins.run("c@d", "f", "Gehalt", "", "full", 1, "failed");
    ins.run("e@f", "f", "Urlaub", "", "full", 1, null); // purged
    ins.run("g@h", "f", "Einkauf", "Milch", "full", 0, null);
    const c = compileQuery("", { hideEncrypted: true });
    const visible = db.prepare(`SELECT subject FROM messages m WHERE ${c.where.join(" AND ")} ORDER BY subject`).all(...c.params).map((r) => r.subject);
    assert.deepEqual(visible, ["Einkauf", "Vertrag"], "decrypted and unencrypted mail are visible");
  } finally {
    db.close();
  }
});

// ─── Purge: remove stored plaintext of decrypted mail ───────────────

test("purgeDecrypted: clears plaintext (incl. FTS), keeps headers and is:encrypted", () => {
  const db = openDb(":memory:");
  try {
    const ins = db.prepare("INSERT INTO messages(mid, folder_id, account_id, subject, body, quoted, snippet, att_text, content_state, encrypted, pgp_state) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const a = ins.run("a@b", "f", "account1", "Vertrag", "Geheimnis XYZ", "Zitat ABC", "Geheimnis…", "rechnung.pdf\nBetrerag 99", "full", 1, "decrypted").lastInsertRowid;
    const b = ins.run("c@d", "f", "account2", "Hallo", "Klartext", "", "Klartext", "", "full", 1, "decrypted").lastInsertRowid;
    const c = ins.run("e@f", "f", "account1", "Normal", "Unverschluesselt", "", "", "", "full", 0, null).lastInsertRowid;
    db.prepare("INSERT INTO attachments(message_id, idx, filename, content_type, size, text, text_state) VALUES(?,?,?,?,?,?,?)").run(a, 1, "rechnung.pdf", "application/pdf", 10, "Betreag 99 EUR", "extracted");
    const vec = Buffer.from(new Float32Array([1, 0]).buffer);
    for (const id of [a, b, c]) db.prepare("INSERT INTO embeddings(message_id, model, dim, vec) VALUES(?,?,?,?)").run(id, "m", 2, vec);

    assert.equal(countDecrypted(db).messages, 2);
    assert.equal(countDecrypted(db, { accountIds: ["account1"] }).messages, 1);

    // The plaintext is findable before the purge (and invisible afterwards) in the FTS index too.
    assert.equal(db.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'geheimnis'").get().n, 1);

    const res = purgeDecrypted(db, { accountIds: ["account1"] });
    assert.equal(res.messages, 1);
    assert.equal(res.attachments, 1);
    assert.equal(res.embeddings, 1);
    assert.deepEqual(db.prepare("SELECT message_id FROM embeddings ORDER BY message_id").all().map((r) => r.message_id), [b, c], "only the purged message loses its embedding");
    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(a);
    assert.equal(row.body, "");
    assert.equal(row.quoted, "");
    assert.equal(row.snippet, "");
    assert.equal(row.att_text, "");
    assert.equal(row.pgp_state, null, "so --reparse pgp can decrypt again later");
    assert.equal(row.subject, "Vertrag", "headers stay as indexed");
    assert.equal(row.encrypted, 1, "still marked is:encrypted");
    assert.equal(db.prepare("SELECT text FROM attachments WHERE message_id = ?").get(a).text, null);
    assert.equal(db.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'geheimnis'").get().n, 0, "FTS index cleared too");
    assert.equal(db.prepare("SELECT body FROM messages WHERE id = ?").get(b).body, "Klartext", "other account untouched");
    assert.equal(db.prepare("SELECT body FROM messages WHERE id = ?").get(c).body, "Unverschluesselt", "unencrypted mail untouched");
    assert.equal(countDecrypted(db).messages, 1);
  } finally {
    db.close();
  }
});

test("purgeDecrypted: removes calendar data that came from inside the encryption", () => {
  const db = openDb(":memory:");
  try {
    const id = db.prepare("INSERT INTO messages(mid, folder_id, body, content_state, encrypted, pgp_state) VALUES(?,?,?,?,?,?)").run("a@b", "f", "Termin", "full", 1, "decrypted").lastInsertRowid;
    db.prepare("INSERT INTO events(message_id, start, summary) VALUES(?,?,?)").run(id, Date.now(), "Geheimer Termin");
    const res = purgeDecrypted(db, {});
    assert.equal(res.events, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 0);
  } finally {
    db.close();
  }
});
