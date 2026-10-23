// Encrypted mail end-to-end: PGP/MIME with protected headers and inline PGP through a real
// sync, per-account opt-in (index.decryptPgp), is:encrypted and purge.
// The cases live in test/fixtures/corpus.js; with gpg installed they carry real ciphertext
// encrypted to a throwaway key (facts.pgp.decryptable), without gpg broken armor — detection
// and marking are asserted either way, decryption only when a key is available.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupIndexed, idByMid } from "../helpers.js";
import { search, show, count } from "../../src/ops.js";
import { purgeDecrypted, countDecrypted, tx } from "../../src/db.js";
import { hasGpg } from "../../src/pgp.js";
import { sharedGpgHome } from "../fixtures/pgp.js";

let envAll; // index.decryptPgp: true — every account
let envOne; // index.decryptPgp: ["Privat"] — per-account opt-in
let prevHome;

before(async () => {
  // The corpus encrypts to the throwaway keyring; the sync's gpg child processes must find it.
  if (hasGpg()) {
    prevHome = process.env.GNUPGHOME;
    process.env.GNUPGHOME = sharedGpgHome().home;
  }
  envAll = await setupIndexed({ count: 60, seed: 7, index: { decryptPgp: true } });
  envOne = await setupIndexed({ count: 60, seed: 7, index: { decryptPgp: ["Privat"] } });
});
after(async () => {
  await envAll?.cleanup();
  await envOne?.cleanup();
  if (prevHome === undefined) delete process.env.GNUPGHOME;
  else process.env.GNUPGHOME = prevHome;
});

const cases = () => envAll.corpus.facts.pgp.cases;
// Static skip flags: evaluated at registration time, before the fixtures exist. The corpus
// encrypts its cases exactly when gpg is installed, which is what these flags reflect.
const withKey = hasGpg() ? false : "gpg is not installed";
const withoutKey = hasGpg() ? "gpg is installed" : false;

test("is:encrypted finds both encrypted messages (decrypted or not)", () => {
  const r = search(envAll.db, { query: "is:encrypted", fields: ["id", "mid"] });
  assert.equal(r.total, 2);
  const mids = new Set(r.results.map((x) => x.mid));
  for (const c of cases()) assert.ok(mids.has(c.mid), `${c.kind} is marked`);
});

test("PGP/MIME with protected headers: plaintext and protected Subject are indexed", { skip: withKey }, () => {
  const c = cases().find((x) => x.kind === "pgp-mime");
  assert.equal(search(envAll.db, { query: c.keyword }).total, 1, "plaintext is searchable");
  const m = show(envAll.db, idByMid(envAll.db, c.mid));
  assert.equal(m.subject, c.subject, "protected Subject wins over the outer placeholder");
  assert.match(m.body, new RegExp(c.keyword));
  assert.equal(m.trust.encrypted, true);
  assert.equal(m.trust.decrypted, true);
  assert.equal(m.trust.subject_mismatch, true, "the outer placeholder Subject differs");
});

test("inline PGP: the plaintext replaces the armor in the index", { skip: withKey }, () => {
  const c = cases().find((x) => x.kind === "inline");
  assert.equal(search(envAll.db, { query: c.keyword }).total, 1);
  const m = show(envAll.db, idByMid(envAll.db, c.mid));
  assert.match(m.body, new RegExp(c.keyword));
  assert.ok(!m.body.includes("BEGIN PGP"), "armor is never indexed");
  assert.equal(m.trust.encrypted, true);
  assert.equal(m.trust.decrypted, true);
});

test("without gpg: the messages are marked, but never decrypted", { skip: withoutKey }, () => {
  for (const c of cases()) {
    const m = show(envAll.db, idByMid(envAll.db, c.mid));
    assert.equal(m.trust.encrypted, true, `${c.kind} is marked`);
    assert.ok(!m.body, `${c.kind} has no content`);
    assert.ok(!m.trust.decrypted);
  }
});

test("per-account opt-in: only the chosen account is decrypted", { skip: withKey }, () => {
  const mime = cases().find((x) => x.kind === "pgp-mime"); // account "Privat"
  const inline = cases().find((x) => x.kind === "inline"); // account "Firma"
  const priv = show(envOne.db, idByMid(envOne.db, mime.mid));
  assert.equal(priv.trust.decrypted, true, "Privat is opted in");
  assert.match(priv.body, new RegExp(mime.keyword));
  const firma = show(envOne.db, idByMid(envOne.db, inline.mid));
  assert.equal(firma.trust.encrypted, true, "still marked");
  assert.ok(!firma.trust.decrypted, "Firma is not opted in");
  assert.ok(!firma.body, "no plaintext for accounts that did not opt in");
  assert.equal(search(envOne.db, { query: inline.keyword }).total, 0);
});

test("purge removes the plaintext and keeps the messages findable as encrypted", { skip: withKey }, () => {
  const db = envAll.db;
  const before = countDecrypted(db);
  assert.ok(before.messages >= 2, "decrypted plaintext is in the index");
  const res = tx(db, () => purgeDecrypted(db, {}));
  assert.ok(res.messages >= 2);
  for (const c of cases()) {
    const m = show(db, idByMid(db, c.mid));
    assert.ok(!m.body, `${c.kind} body is gone`);
    assert.equal(m.trust.encrypted, true, "still marked is:encrypted");
    assert.ok(!m.trust.decrypted);
    assert.equal(search(db, { query: c.keyword }).total, 0, "plaintext is gone from the full-text index");
  }
  assert.equal(count(db, { query: "is:encrypted" }).total, 2, "headers stay findable via is:encrypted");
  const mime = cases().find((x) => x.kind === "pgp-mime");
  assert.equal(show(db, idByMid(db, mime.mid)).subject, mime.subject, "the Subject stays as indexed");
});
