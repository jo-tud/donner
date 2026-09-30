// End-to-end tests of the `donner` binary.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { setupIndexed, runCli, tempDir } from "../helpers.js";

let env;
before(async () => {
  env = await setupIndexed({ count: 200, sync: false, seed: 11 });
});
after(async () => {
  await env?.cleanup();
});

test("search before sync: NO_INDEX with a hint and exit code 4", async () => {
  const r = await runCli(["search", "rechnung"], { env: { ...env.env, DONNER_DB: join(tempDir(), "none.sqlite") } });
  assert.equal(r.code, 4);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, "NO_INDEX");
  assert.match(r.json.error.hint, /donner sync/);
  const empty = await runCli(["search", "rechnung"], { env: env.env });
  assert.equal(empty.code, 0);
  assert.match(empty.json.data.note, /donner sync/);
});

test("sync builds the index; JSON envelope on stdout", async () => {
  const r = await runCli(["sync"], { env: env.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.data.added > 100);
  assert.equal(r.stderr, "", "no progress noise when not a TTY");
  if (platform() !== "win32") {
    assert.equal(statSync(env.dbPath).mode & 0o777, 0o600, "index file is private");
  }
});

test("search returns compact results; --fields selects", async () => {
  const r = await runCli(["search", "rechnung", "-n", "3"], { env: env.env });
  assert.equal(r.code, 0);
  const d = r.json.data;
  assert.equal(d.results.length, 3);
  assert.ok(d.total >= 3);
  assert.ok(d.results[0].id && d.results[0].subject);
  const f = await runCli(["search", "rechnung", "-n", "2", "--fields", "id,date"], { env: env.env });
  assert.deepEqual(Object.keys(f.json.data.results[0]).sort(), ["date", "id"]);
  const bad = await runCli(["search", "x", "--fields", "id,nope"], { env: env.env });
  assert.equal(bad.code, 2);
  assert.match(bad.json.error.message, /Unknown field "nope"/);
});

test("search flags equal operators", async () => {
  const a = await runCli(["search", "from:stadtwerke", "--sort", "date", "-n", "50", "--fields", "id"], { env: env.env });
  const b = await runCli(["search", "--from", "stadtwerke", "--sort", "date", "-n", "50", "--fields", "id"], { env: env.env });
  assert.deepEqual(a.json.data, b.json.data);
});

test("show, thread, count, people, schema, status, config, version", async () => {
  const s = await runCli(["search", "subject:Angebot", "-n", "1", "--fields", "id"], { env: env.env });
  const id = String(s.json.data.results[0].id);
  const show = await runCli(["show", id, "--max-body", "50"], { env: env.env });
  assert.equal(show.code, 0);
  assert.match(show.json.data.notice, /untrusted/);
  assert.equal(show.json.data.messages.length, 1);
  assert.ok(show.json.data.messages[0].body.length <= 51);
  const th = await runCli(["thread", id], { env: env.env });
  assert.ok(th.json.data.count >= 1);
  const c = await runCli(["count", "has:pdf", "--by", "month"], { env: env.env });
  assert.ok(c.json.data.groups.length > 0);
  const t = await runCli(["threads", "--min", "3", "--mine", "-n", "2"], { env: env.env });
  assert.equal(t.code, 0);
  assert.ok(t.json.data.threads.every((x) => x.messages >= 3));
  const p = await runCli(["people", "-n", "3"], { env: env.env });
  assert.equal(p.json.data.people.length, 3);
  const sc = await runCli(["schema"], { env: env.env });
  assert.match(sc.json.data.schema, /messages_fts/);
  const st = await runCli(["status"], { env: env.env });
  assert.ok(st.json.data.messages > 0);
  const cfg = await runCli(["config"], { env: { ...env.env, TB_AUTH_TOKEN: "secret-token" } });
  assert.equal(cfg.json.data.bridge.authToken, "***", "token is redacted");
  assert.doesNotMatch(cfg.stdout, /secret-token/);
  const v = await runCli(["--version"], { env: env.env });
  assert.match(v.json.data.version, /^\d+\.\d+\.\d+/);
});

test("human output renders without errors", async () => {
  for (const args of [["search", "rechnung", "-n", "3"], ["status", "--folders"], ["people"], ["count", "--by", "year"], ["count", "--by", "year,direction"], ["threads", "--min", "3"], ["search", "has:event", "--sort", "event"], ["help"], ["help", "search"], ["doctor"]]) {
    const r = await runCli([...args, "--human"], { env: env.env });
    assert.ok(r.code === 0, `${args.join(" ")}: ${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, args.join(" "));
    assert.doesNotMatch(r.stdout, /undefined|\[object Object\]|NaN/, args.join(" "));
  }
});

test("sql: read-only queries work, writes are rejected", async () => {
  const ok = await runCli(["sql", "SELECT count(*) AS n FROM messages"], { env: env.env });
  assert.equal(ok.code, 0);
  assert.ok(ok.json.data.rows[0].n > 0);
  const view = await runCli(["sql", "SELECT id, date, folder FROM mail ORDER BY date DESC LIMIT 2"], { env: env.env });
  assert.equal(view.json.data.rows.length, 2);
  for (const bad of ["DELETE FROM messages", "ATTACH DATABASE '/tmp/x' AS x", "SELECT 1; DELETE FROM messages", "PRAGMA journal_mode=DELETE"]) {
    const r = await runCli(["sql", bad], { env: env.env });
    assert.equal(r.code, 1, bad);
    assert.equal(r.json.error.code, "SQL_REJECTED", bad);
  }
  const n = await runCli(["sql", "SELECT count(*) AS n FROM messages"], { env: env.env });
  assert.equal(n.json.data.rows[0].n, ok.json.data.rows[0].n, "nothing was deleted");
  const slow = await runCli(["sql", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", "--timeout", "2s"], { env: env.env });
  assert.equal(slow.json.error.code, "SQL_TIMEOUT");
  const cap = await runCli(["sql", "SELECT id, body FROM messages", "--max-rows", "3", "--max-cell", "10"], { env: env.env });
  assert.equal(cap.json.data.rows.length, 3);
  assert.equal(cap.json.data.truncated, true);
});

test("resolve gives a Thunderbird id that points at the same message", async () => {
  const s = await runCli(["search", "rechnung", "-n", "1", "--fields", "id,mid"], { env: env.env });
  const { id, mid } = s.json.data.results[0];
  const r = await runCli(["resolve", String(id)], { env: env.env });
  const tbId = r.json.data.resolved[0].tb_id;
  const hdr = await env.bridge.headers(tbId);
  assert.equal(hdr.headerMessageId, mid);
});

test("attachment: print text, save original file", async () => {
  const s = await runCli(["search", "has:pdf rechnung", "-n", "1", "--fields", "id"], { env: env.env });
  const id = String(s.json.data.results[0].id);
  const t = await runCli(["attachment", id, "1"], { env: env.env });
  assert.match(t.json.data.text, /Rechnungsbetrag/);
  const dir = tempDir();
  const out = join(dir, "r.pdf");
  const sv = await runCli(["attachment", id, "1", "--save", out], { env: env.env });
  assert.equal(sv.code, 0, sv.stderr);
  assert.equal(readFileSync(out).subarray(0, 5).toString(), "%PDF-");
  const again = await runCli(["attachment", id, "1", "--save", out], { env: env.env });
  assert.equal(again.code, 2, "refuses to overwrite without --force");
});

test("usage errors: exit code 2 and a hint", async () => {
  const u = await runCli(["frobnicate"], { env: env.env });
  assert.equal(u.code, 2);
  assert.equal(u.json.error.code, "UNKNOWN_COMMAND");
  const o = await runCli(["search", "--nope"], { env: env.env });
  assert.equal(o.code, 2);
  const i = await runCli(["show", "abc"], { env: env.env });
  assert.equal(i.code, 2);
  const q = await runCli(["search", "from:"], { env: env.env });
  assert.equal(q.code, 2);
  assert.match(q.json.error.message, /needs a value/);
});

test("bridge down: sync fails with exit code 3, search still works", async () => {
  const e = { ...env.env, DONNER_BRIDGE_PORT: "9" };
  const r = await runCli(["sync"], { env: e });
  assert.equal(r.code, 3);
  assert.equal(r.json.error.code, "BRIDGE_UNREACHABLE");
  const s = await runCli(["search", "rechnung", "-n", "1"], { env: e });
  assert.equal(s.code, 0);
});

test("concurrent syncs are prevented by the lock", async () => {
  const [a, b] = await Promise.all([runCli(["sync", "--full"], { env: env.env }), runCli(["sync", "--full"], { env: env.env })]);
  const codes = [a.code, b.code].sort();
  if (codes[1] !== 0) {
    const loser = a.code ? a : b;
    assert.equal(loser.json.error.code, "SYNC_RUNNING");
  }
  assert.ok(!existsSync(env.dbPath + ".lock"), "lock released");
});

test("skill install writes SKILL.md", async () => {
  const dir = tempDir();
  const r = await runCli(["skill", "install", "--dir", dir], { env: env.env });
  assert.equal(r.code, 0);
  assert.match(readFileSync(join(dir, "donner", "SKILL.md"), "utf8"), /^---\nname: donner/);
});

test("negated words and filters as separate arguments are query terms", async () => {
  const all = await runCli(["count", "rechnung"], { env: env.env });
  const neg = await runCli(["count", "rechnung", "-from:stadtwerke"], { env: env.env });
  const only = await runCli(["count", "rechnung", "from:stadtwerke"], { env: env.env });
  assert.equal(neg.code, 0, neg.stderr);
  assert.equal(neg.json.data.total + only.json.data.total, all.json.data.total);
  const s = await runCli(["search", "rechnung", "-newsletter", "-n", "2"], { env: env.env });
  assert.equal(s.code, 0);
  assert.equal(s.json.data.results.length, 2);
  const g = await runCli(["--db", env.dbPath, "count", "rechnung"], { env: env.env });
  assert.equal(g.json.data.total, all.json.data.total, "global option before the command");
});

test("did-you-mean for command typos; help for unknown command is an error", async () => {
  const t = await runCli(["serch", "x"], { env: env.env });
  assert.equal(t.code, 2);
  assert.match(t.json.error.hint, /donner search/);
  const h = await runCli(["help", "nonsense"], { env: env.env });
  assert.equal(h.code, 2);
});

test("attachment --save into a directory uses the original file name", async () => {
  const s = await runCli(["search", "has:pdf rechnung", "-n", "1", "--fields", "id"], { env: env.env });
  const id = String(s.json.data.results[0].id);
  const dir = tempDir();
  const r = await runCli(["attachment", id, "1", "--save", dir], { env: env.env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.data.path, /Rechnung_.*\.pdf$/);
});

test("invalid configuration values are reported", async () => {
  const r = await runCli(["status"], { env: { ...env.env, DONNER_BRIDGE_PORT: "abc" } });
  assert.equal(r.code, 1);
  assert.match(r.json.error.message, /DONNER_BRIDGE_PORT must be a number/);
});

test("reset needs --yes and removes the index", async () => {
  const x = await runCli(["reset"], { env: env.env });
  assert.equal(x.code, 2);
  assert.ok(existsSync(env.dbPath));
  const y = await runCli(["reset", "--yes"], { env: env.env });
  assert.equal(y.code, 0);
  assert.ok(!existsSync(env.dbPath));
});
