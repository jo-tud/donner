// MCP server over stdio + semantic search with a fake local embedding service.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { setupIndexed, BIN } from "../helpers.js";
import { embedAll, semanticSearch } from "../../src/semantic.js";
import { TOOLS } from "../../src/mcp.js";

let env;
let embedServer;
let embedPort;
let embedCalls = 0;

// Deterministic "embedding": hashed bag of words with a few synonyms mapped together,
// so meaning-based search is testable without a model.
const SYN = { verzögert: "delay", verzug: "delay", lieferverzug: "delay", delayed: "delay", late: "delay", verspätet: "delay", rechnung: "invoice", invoice: "invoice", bill: "invoice" };
function fakeEmbed(text) {
  const v = new Array(64).fill(0);
  for (let w of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w || w === "search_document" || w === "search_query") continue;
    w = SYN[w] || w;
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
}

before(async () => {
  env = await setupIndexed({ count: 250, seed: 21 });
  embedServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      embedCalls++;
      const { input } = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ embeddings: input.map(fakeEmbed) }));
    });
  });
  await new Promise((r) => embedServer.listen(0, "127.0.0.1", r));
  embedPort = embedServer.address().port;
  env.cfg.embeddings = { ...env.cfg.embeddings, enabled: true, url: `http://127.0.0.1:${embedPort}`, model: "fake-embed" };
});

after(async () => {
  embedServer?.close();
  await env?.cleanup();
});

function startMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [BIN, "mcp"], { env: { ...env.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args });
    return { ...r.result, data: JSON.parse(r.result.content[0].text) };
  };
  return { child, request, call, notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"), close: () => child.stdin.end() };
}

test("MCP: initialize, list tools, read-only annotations", async () => {
  const s = startMcp();
  try {
    const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "donner");
    assert.match(init.result.instructions, /untrusted/);
    s.notify("notifications/initialized");
    const old = await s.request("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(old.result.protocolVersion, "2025-11-25");
    const list = await s.request("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names, TOOLS.map((t) => t.name));
    for (const t of list.result.tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.equal(t.inputSchema.type, "object");
    }
    const ping = await s.request("ping", {});
    assert.deepEqual(ping.result, {});
    const unknown = await s.request("does/not/exist", {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    s.close();
  }
});

test("MCP: search → read → thread → count → people → sql → status → resolve", async () => {
  const s = startMcp();
  try {
    await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const inv = env.corpus.facts.invoices[0];
    const r = await s.call("mail_search", { query: inv.number, limit: 3 });
    assert.equal(r.isError, undefined);
    const hit = r.data.results.find((x) => x.subject.includes(inv.number));
    assert.ok(hit);
    const read = await s.call("mail_read", { ids: [hit.id], include_attachments: true, max_body: 500 });
    assert.match(read.data.notice, /untrusted/);
    assert.match(read.data.messages[0].attachments[0].content, new RegExp(inv.amountDe));
    const th = await s.call("mail_thread", { id: hit.id });
    assert.ok(th.data.count >= 1);
    const c = await s.call("mail_count", { query: "has:pdf", by: "year" });
    assert.ok(c.data.total > 0);
    const c2 = await s.call("mail_count", { by: "year,direction" });
    assert.ok(c2.data.groups.some((g) => g.direction === "sent") && c2.data.groups.some((g) => g.direction === "received"));
    const t = await s.call("mail_threads", { min_messages: 3, mine: true, limit: 5 });
    assert.ok(t.data.threads.length > 0 && t.data.threads.every((x) => x.messages >= 3 && x.by_me > 0));
    const p = await s.call("mail_people", { limit: 3 });
    assert.equal(p.data.people.length, 3);
    const q = await s.call("mail_sql", { sql: "SELECT count(DISTINCT mid) AS n FROM messages" });
    assert.ok(q.data.rows[0].n > 0);
    const st = await s.call("mail_status", {});
    assert.ok(st.data.messages > 0);
    const rs = await s.call("mail_resolve_tb_id", { ids: [hit.id] });
    const hdr = await env.bridge.headers(rs.data.resolved[0].tb_id);
    assert.equal(hdr.headerMessageId, inv.mid);
    const schema = await s.call("mail_schema", {});
    assert.match(schema.data.schema, /addresses/);
  } finally {
    s.close();
  }
});

test("MCP: bad arguments and forbidden SQL are tool errors, not crashes", async () => {
  const s = startMcp();
  try {
    await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const a = await s.call("mail_read", { ids: "1" });
    assert.equal(a.isError, true);
    assert.equal(a.data.error.code, "INVALID_ARGS");
    const b = await s.call("mail_search", { query: "x", evil: true });
    assert.equal(b.isError, true);
    const c = await s.call("mail_sql", { sql: "ATTACH DATABASE '/etc/passwd' AS p" });
    assert.equal(c.data.error.code, "SQL_REJECTED");
    const d = await s.call("mail_sql", { sql: "SELECT 1; DELETE FROM messages" });
    assert.equal(d.data.error.code, "SQL_REJECTED");
    const e = await s.call("nope", {});
    assert.equal(e.isError, true);
    const f = await s.call("mail_read", { ids: Array.from({ length: 21 }, (_, i) => i + 1) });
    assert.equal(f.isError, true);
    // still alive
    const ok = await s.call("mail_status", {});
    assert.ok(ok.data.messages > 0);
    // invalid JSON line
    s.child.stdin.write("this is not json\n");
    const again = await s.call("mail_status", {});
    assert.ok(again.data.messages > 0);
  } finally {
    s.close();
  }
});

test("semantic: embed, then meaning-based and hybrid search", async () => {
  const { db, cfg } = env;
  const res = await embedAll(db, cfg, {});
  assert.ok(res.embedded > 100);
  const again = await embedAll(db, cfg, {});
  assert.equal(again.embedded, 0, "incremental: nothing to do the second time");

  // "late" never appears in German delay mails, but maps to the same meaning.
  const sem = await semanticSearch(db, cfg, { query: "late", limit: 5, fields: ["id", "subject", "snippet"] });
  assert.ok(sem.results.length > 0);
  assert.ok(sem.results.some((r) => /verzög|Lieferverzug|delay/i.test(r.subject + " " + r.snippet)), JSON.stringify(sem.results));

  const hyb = await semanticSearch(db, cfg, { query: "rechnung from:stadtwerke", limit: 5, fields: ["id", "from"], mode: "hybrid" });
  assert.ok(hyb.results.length > 0);
  assert.ok(hyb.results.every((r) => r.from.includes("stadtwerke")), "operators still filter");
});

test("semantic: remote endpoints are refused unless allowed", async () => {
  const cfg = structuredClone(env.cfg);
  cfg.embeddings.url = "https://api.example.com";
  await assert.rejects(semanticSearch(env.db, cfg, { query: "x" }), (e) => e.code === "REMOTE_EMBEDDINGS_BLOCKED");
  void embedCalls;
});
