// Benchmark: sync throughput and query latency on a synthetic mailbox.
//
//   node test/bench.js [messages=50000]
//
// Runs through the real thunderbird-cli bridge + extension on a simulated Thunderbird, so
// it measures donner + bridge overhead. Real Thunderbird adds disk/IMAP time on first sync.

import { statSync } from "node:fs";
import { join } from "node:path";
import { setupIndexed } from "./helpers.js";
import * as ops from "../src/ops.js";
import { runSql } from "../src/sql.js";

const N = Number(process.argv[2] || 50000);
const t0 = Date.now();
const env = await setupIndexed({ count: N, seed: 1234, sync: false, separateProcess: true });
const genMs = Date.now() - t0;
console.log(`started simulated Thunderbird with ${N} messages in ${(genMs / 1000).toFixed(1)}s`);

let t = Date.now();
let last = 0;
let maxLag = 0;
let lastTick = Date.now();
const lagTimer = setInterval(() => {
  const now = Date.now();
  maxLag = Math.max(maxLag, now - lastTick - 250);
  lastTick = now;
}, 250);
const s1 = await env.resync({
  onProgress: (ev) => {
    if (ev.phase === "content" && Date.now() - last > 5000) {
      last = Date.now();
      process.stderr.write(`  ${ev.done}/${ev.total}\n`);
    }
  },
});
const syncMs = Date.now() - t;
clearInterval(lagTimer);
t = Date.now();
const s2 = await env.resync();
const noopMs = Date.now() - t;

const queries = [
  "rechnung",
  "rechnung stadtwerke",
  '"Rechnungsbetrag"',
  "from:mueller",
  "lieferverzug after:2025-01",
  "has:pdf newer_than:1y",
  "angebot OR offer -newsletter",
  "budget in:inbox is:unread",
];
const lat = [];
for (const q of queries) {
  const times = [];
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    total = ops.search(env.db, { query: q, limit: 20 }).total;
    times.push(performance.now() - a);
  }
  times.sort((a, b) => a - b);
  lat.push({ query: q, hits: total, p50_ms: +times[10].toFixed(2), p95_ms: +times[18].toFixed(2) });
}
const agg = [];
const time = async (label, fn) => {
  const a = performance.now();
  await fn();
  agg.push({ op: label, ms: +(performance.now() - a).toFixed(1) });
};
await time("count has:pdf --by month", () => ops.count(env.db, { query: "has:pdf", by: "month" }));
await time("count --by from (all mail)", () => ops.count(env.db, { query: "", by: "from" }));
await time("people (top 20)", () => ops.people(env.db, { limit: 20 }));
const tid = env.db.prepare("SELECT thread_id FROM messages GROUP BY thread_id ORDER BY count(*) DESC LIMIT 1").get().thread_id;
await time("thread (largest)", () => ops.thread(env.db, tid));
await time("sql: invoices per vendor (child process)", () => runSql(env.dbPath, "SELECT from_addr, count(*) n FROM messages WHERE subject LIKE 'Ihre Rechnung%' GROUP BY from_addr"));

let bytes = statSync(env.dbPath).size;
try {
  bytes += statSync(env.dbPath + "-wal").size;
} catch {
  // no wal
}
const report = {
  messages_indexed: s1.added,
  initial_sync_s: +(syncMs / 1000).toFixed(1),
  initial_sync_msgs_per_s: Math.round(s1.added / (syncMs / 1000)),
  max_event_loop_lag_ms_during_sync: maxLag,
  noop_sync_ms: noopMs,
  noop_folders_listed: s2.foldersListed,
  index_mb: +(bytes / 1048576).toFixed(1),
  bytes_per_message: Math.round(bytes / s1.added),
  search_latency: lat,
  aggregates: agg,
  node: process.version,
  db: join(env.dir, "index.sqlite"),
};
console.log(JSON.stringify(report, null, 2));
await env.cleanup();
