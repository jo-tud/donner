import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, compileQuery, ftsTerm, parseDateStart, freeText, operatorsOnly, parse, wordVariants } from "../../src/query.js";
import { fold } from "../../src/text.js";
import { validateSql, sqlSkeleton } from "../../src/sql.js";

test("tokenize: words, phrases, fields, negation, unknown prefixes", () => {
  const t = tokenize('rechnung "genaue phrase" from:anna -to:"Bob B" https://x.y/z Re:');
  assert.deepEqual(
    t.map((x) => [x.neg, x.field, x.value, x.quoted]),
    [
      [false, null, "rechnung", false],
      [false, null, "genaue phrase", true],
      [false, "from", "anna", false],
      [true, "to", "Bob B", true],
      [false, null, "https://x.y/z", false],
      [false, null, "Re:", false],
    ]
  );
});

test("empty operator value is an error", () => {
  assert.throws(() => tokenize("from:"), /needs a value/);
  assert.throws(() => tokenize("from: anna"), /needs a value/);
});

test("ftsTerm: prefix and German transliteration (index stores ä as ae, ß as ss)", () => {
  assert.equal(ftsTerm("Rechnung"), '"rechnung"*');
  assert.equal(ftsTerm("Mueller"), '"mueller"*');
  assert.equal(ftsTerm("Müller"), '"mueller"*');
  assert.equal(ftsTerm("Straße"), '"strasse"*');
  assert.equal(ftsTerm("poet"), '"poet"*', "no ae/oe/ue → a/o/u variants (poet ≠ pot, true ≠ tru)");
  assert.equal(ftsTerm("a@b.de"), '"a b de"');
  assert.equal(ftsTerm('x"y'), '"x y"');
});

test("compileQuery builds FTS match and SQL filters", () => {
  const c = compileQuery('angebot OR offer -newsletter from:mueller has:attachment is:unread after:2025-01 "net 30"');
  assert.equal(c.match, '("angebot"* OR "offer"*) AND "net 30"');
  assert.equal(c.hasText, true);
  assert.ok(c.where.some((w) => w.includes("m.from_fold LIKE")));
  assert.ok(c.where.some((w) => w.includes("attachment_count > 0")));
  assert.ok(c.where.some((w) => w.includes("m.read = 0")));
  assert.ok(c.where.some((w) => w.startsWith("NOT COALESCE((m.id IN (SELECT rowid FROM messages_fts")));
  assert.ok(c.params.includes('"newsletter"*'));
  assert.ok(c.params.includes("%mueller%"), "participant values are folded");
});

test("compileQuery: negated filters use COALESCE (NULL columns count as not matching)", () => {
  const c = compileQuery("-in:sent subject:budget");
  assert.ok(c.where[0].startsWith("NOT COALESCE(("));
  assert.equal(c.match, 'subject : ("budget"*)');
});

test("parse: OR binds tighter than AND, groups, negated groups, OR between filters", () => {
  assert.deepEqual(parse("a OR b c"), { k: "and", items: [{ k: "or", items: [{ k: "term", field: null, value: "a", quoted: false }, { k: "term", field: null, value: "b", quoted: false }] }, { k: "term", field: null, value: "c", quoted: false }] });
  const g = parse("wartung (from:bjorn OR to:bjorn)");
  assert.equal(g.k, "and");
  assert.equal(g.items[1].k, "or");
  assert.equal(g.items[1].items[0].field, "from");
  assert.equal(parse("-(a b)").k, "not");
  assert.equal(parse("from:x or to:x").k, "or");
  const c = compileQuery("wartung (from:bjorn OR to:bjorn)");
  assert.equal(c.match, '"wartung"*');
  assert.match(c.where[0], / OR /);
  assert.throws(() => parse("a OR"), /both sides/);
  assert.throws(() => parse("a )"), /Unbalanced/);
  assert.equal(parse("smile :)").k, "and", "a glued \")\" without an open group stays part of the word");
  assert.throws(() => parse("()"), /Empty/);
});

test("unknown operators are rejected, URLs and 'Re:' stay words", () => {
  assert.throws(() => compileQuery("sender:bjorn"), /Unknown operator "sender:"/);
  assert.equal(compileQuery('"sender:bjorn"').match, '"sender bjorn"');
  assert.ok(compileQuery("https://example.com/x").match);
  assert.ok(compileQuery("Re:").match);
  assert.ok(compileQuery("with:anna from:me to:me has:invite is:suspicious event_after:2026-01").where.length === 6);
});

test("invalid calendar dates are rejected", () => {
  assert.throws(() => parseDateStart("2025-13"), /Cannot understand/);
  assert.throws(() => parseDateStart("31.02.2025"), /Cannot understand/);
  assert.equal(parseDateStart("2024-02-29"), new Date(2024, 1, 29).getTime());
});

test("fold: tolerant participant matching", () => {
  assert.equal(fold("Björn Söderström"), fold("Bjoern Soederstroem"));
  assert.equal(fold("MÜLLER"), fold("mueller"));
  assert.notEqual(fold("Mauer"), fold("Maur"));
  assert.equal(fold("Weiß"), fold("weiss"));
  assert.equal(fold("José"), fold("jose"));
  assert.equal(fold("Mu\u0308ller"), fold("Müller"), "decomposed umlauts");
  assert.deepEqual(wordVariants("größe"), ["groesse"]);
});

test("compileQuery rejects unknown is:/has: values with a hint", () => {
  assert.throws(() => compileQuery("is:bogus"), /Unknown is:bogus/);
  assert.throws(() => compileQuery("has:bogus"), /Unknown has:bogus/);
  assert.throws(() => compileQuery("after:notadate"), /Cannot understand the date/);
});

test("LIKE wildcards in operator values are escaped", () => {
  const c = compileQuery("from:100%_sure");
  assert.ok(c.params.includes("%100\\%\\_sure%"));
});

test("parseDateStart: absolute (local time) and relative dates", () => {
  const now = new Date(2026, 5, 15, 12).getTime();
  assert.equal(parseDateStart("2025", now), new Date(2025, 0, 1).getTime());
  assert.equal(parseDateStart("2025-03", now), new Date(2025, 2, 1).getTime());
  assert.equal(parseDateStart("2025-03-14", now), new Date(2025, 2, 14).getTime());
  assert.equal(parseDateStart("14.03.2025", now), new Date(2025, 2, 14).getTime());
  assert.equal(parseDateStart("7d", now), now - 7 * 86400000);
  assert.equal(parseDateStart("today", now), new Date(2026, 5, 15).getTime());
});

test("freeText / operatorsOnly split a query for semantic search", () => {
  const q = 'late delivery from:anna -to:bob after:2025 "server rack"';
  assert.equal(freeText(q), "late delivery server rack");
  assert.equal(operatorsOnly(q), "from:anna -to:bob after:2025");
});

test("validateSql accepts read-only queries", () => {
  for (const sql of [
    "SELECT 1",
    "select count(*) from messages;",
    "WITH x AS (SELECT id FROM messages) SELECT * FROM x",
    "SELECT replace(subject, 'a', 'b') FROM messages",
    "SELECT 'ATTACH DATABASE' AS s",
    "SELECT \"delete\" FROM (SELECT 1 AS \"delete\")",
    "VALUES (1),(2)",
    "EXPLAIN QUERY PLAN SELECT * FROM messages",
    "SELECT * FROM pragma_table_info('messages')",
    "-- comment with DROP\nSELECT 1",
  ]) {
    assert.equal(validateSql(sql), true, sql);
  }
});

test("validateSql rejects writes, attach, pragma, multiple statements", () => {
  for (const sql of [
    "DELETE FROM messages",
    "ATTACH DATABASE '/tmp/x.db' AS x",
    "PRAGMA writable_schema = 1",
    "SELECT 1; DROP TABLE messages",
    "WITH x AS (SELECT 1) DELETE FROM messages",
    "WITH x AS (SELECT 1) INSERT INTO meta VALUES ('a','b')",
    "VACUUM INTO '/tmp/copy.db'",
    "SELECT load_extension('/tmp/evil.so')",
    "SELECT writefile('/tmp/x', 'y')",
    "SELECT 1 /* ; */ ; SELECT 2",
    "REPLACE INTO meta VALUES('a','b')",
    "",
  ]) {
    assert.throws(() => validateSql(sql), /not allowed|single statement|Only read-only|Empty/, sql);
  }
});

test("sqlSkeleton hides literals and comments", () => {
  assert.equal(sqlSkeleton("SELECT 'x;y' -- ; drop\n").includes(";"), false);
  assert.equal(sqlSkeleton('SELECT "a;b"').includes(";"), false);
});

import { folderType, folderIndexed } from "../../src/sync.js";
import { DEFAULTS } from "../../src/config.js";

test("folder types: reported type wins, names are a fallback", () => {
  assert.equal(folderType({ type: "inbox", path: "/Spam" }), "inbox");
  assert.equal(folderType({ specialUse: ["junk"], path: "/Foo" }), "junk");
  assert.equal(folderType({ path: "/Spam", name: "Spam" }), "junk");
  assert.equal(folderType({ path: "/Papierkorb", name: "Papierkorb" }), "trash");
  assert.equal(folderType({ path: "/Projekte/Spam", name: "Spam" }), "junk", "junk/trash/sent names count at any depth");
  assert.equal(folderType({ path: "/Uni/+spamverdacht", name: "+spamverdacht" }), "junk");
  assert.equal(folderType({ path: "/Archiv 2012/Gesendete Objekte", name: "Gesendete Objekte" }), "sent");
  assert.equal(folderType({ path: "/Projekte/Spam-Filter", name: "Spam-Filter" }), null);
  assert.equal(folderType({ path: "/Sent-1", name: "Sent-1" }), "sent");
  assert.equal(folderType({ path: "/[Gmail]/sent-mail", name: "sent-mail" }), "sent");
  assert.equal(folderType({ path: "/Sent Items", name: "Sent Items" }), "sent");
  assert.equal(folderType({ path: "/Sentinel", name: "Sentinel" }), null);
  assert.equal(folderType({ path: "/Kunden/Inbox", name: "Inbox" }), null, "other types only at the top level");
  const cfg = structuredClone(DEFAULTS);
  const acct = { id: "account1", name: "Firma" };
  assert.equal(folderIndexed(cfg, acct, { id: "account1://Spam", path: "/Spam", name: "Spam" }), false);
  assert.equal(folderIndexed(cfg, acct, { id: "account1://INBOX", path: "/INBOX", name: "Inbox", type: "inbox" }), true);
  cfg.index.excludeFolders = ["Firma/Projekte/**"];
  assert.equal(folderIndexed(cfg, acct, { id: "account1://Projekte/A/B", path: "/Projekte/A/B", name: "B" }), false);
  cfg.index.excludeFolders = [];
  cfg.index.includeFolders = ["Firma/INBOX"];
  assert.equal(folderIndexed(cfg, acct, { id: "account1://Sent", path: "/Sent", name: "Sent", type: "sent" }), false);
  cfg.index.includeFolders = [];
  cfg.index.accounts = ["Privat"];
  assert.equal(folderIndexed(cfg, acct, { id: "account1://INBOX", path: "/INBOX", name: "Inbox", type: "inbox" }), false);
});

test("second review: prototype keys, pruning, caps, semantic split", () => {
  for (const q of ["is:constructor", "is:__proto__", "has:constructor", "has:toString"]) assert.throws(() => compileQuery(q), /Unknown/, q);
  assert.throws(() => compileQuery("toString:x"), /Unknown operator/);
  assert.equal(compileQuery('rechnung -"!"').where.length, 0, "empty negated term is dropped");
  assert.equal(compileQuery("(from:anna OR .)").where[0].includes(" OR "), false, "empty alternative does not match everything");
  assert.throws(() => compileQuery(Array.from({ length: 300 }, (_, i) => `-w${i}`).join(" ")), /too many terms/);
  assert.throws(() => compileQuery("(".repeat(50) + "a" + ")".repeat(50)), /nested too deeply/);
  assert.equal(operatorsOnly("(from:a OR from:b) x"), "(from:a OR from:b)");
  assert.equal(operatorsOnly("x -(spam news)"), "-(spam news)");
  assert.equal(freeText("x -(spam news) (a OR b)"), "x a b");
  assert.equal(compileQuery("subject:(a b) c").match, 'subject : ("a"* AND "b"*) AND "c"*');
});

test("second review: quoted identifiers cannot smuggle blocked functions", () => {
  for (const sql of [`SELECT "load_extension"('/tmp/x')`, "SELECT [load_extension]('/tmp/x')", "SELECT `fts3_tokenizer`('simple')"]) {
    assert.throws(() => validateSql(sql), /not allowed/, sql);
  }
  assert.equal(validateSql('SELECT "delete" FROM (SELECT 1 AS "delete")'), true);
});

test("uppercase AND is a no-op, uppercase NOT negates the next word, operator or group", () => {
  assert.equal(compileQuery("rechnung AND stadtwerke").match, compileQuery("rechnung stadtwerke").match);
  const n = compileQuery("rechnung NOT newsletter");
  assert.equal(n.match, '"rechnung"*');
  assert.ok(n.params.includes('"newsletter"*'));
  assert.ok(compileQuery("NOT from:x").where[0].startsWith("NOT COALESCE("));
  assert.deepEqual(parse("NOT (a OR b) c"), parse("-(a OR b) c"));
  assert.deepEqual(parse("a NOT -b"), parse("a b"), "double negation");
  assert.equal(compileQuery("not and").match, '"not"* AND "and"*', "lowercase stays words");
  assert.equal(compileQuery('"AND"').match, '"and"', "quoted stays a word");
});

test("until: is inclusive (end of the named period), before: stays exclusive", async () => {
  const { parseDateUntil } = await import("../../src/query.js");
  const jan = compileQuery("since:2025-01 until:2025-01");
  assert.deepEqual(jan.params, [new Date(2025, 0, 1).getTime(), new Date(2025, 1, 1).getTime()]);
  assert.equal(parseDateUntil("2025"), new Date(2026, 0, 1).getTime());
  assert.equal(parseDateUntil("2025-12-31"), new Date(2026, 0, 1).getTime());
  assert.equal(parseDateUntil("31.12.2025"), new Date(2026, 0, 1).getTime());
  assert.deepEqual(compileQuery("before:2025-01").params, [new Date(2025, 0, 1).getTime()]);
});
