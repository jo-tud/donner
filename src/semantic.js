// Optional meaning-based search with a local embedding model (Ollama by default).
//
// Vectors are stored L2-normalised as float32 blobs; search is a brute-force dot product,
// which is fast enough for personal mailboxes (100k messages ≈ 1 s) and needs no extension.

import { DonnerError } from "./errors.js";
import { isLoopbackHost } from "./config.js";
import { compileQuery, freeText, operatorsOnly } from "./query.js";
import * as ops from "./ops.js";

function endpoint(cfg) {
  const e = cfg.embeddings || {};
  let url;
  try {
    url = new URL(e.url);
  } catch {
    throw new DonnerError("CONFIG_ERROR", `embeddings.url is not a valid URL: ${e.url}`);
  }
  if (!isLoopbackHost(url.hostname) && !e.allowRemote) {
    throw new DonnerError("REMOTE_EMBEDDINGS_BLOCKED", `Embedding endpoint ${url.host} is not on this machine.`,
      'Sending mail text to a remote service is disabled by default. Set "embeddings": {"allowRemote": true} only if you accept that.');
  }
  return { url, e };
}

function prefixes(model) {
  if (/nomic/i.test(model)) return { doc: "search_document: ", query: "search_query: " };
  if (/e5/i.test(model)) return { doc: "passage: ", query: "query: " };
  return { doc: "", query: "" };
}

export async function embedTexts(cfg, texts, { timeoutMs = 120000 } = {}) {
  const { url, e } = endpoint(cfg);
  const headers = { "Content-Type": "application/json" };
  if (e.apiKeyEnv) {
    const key = process.env[e.apiKeyEnv];
    if (!key) throw new DonnerError("CONFIG_ERROR", `Environment variable ${e.apiKeyEnv} (embeddings.apiKeyEnv) is not set.`);
    headers.Authorization = `Bearer ${key}`;
  }
  let res;
  const base = url.href.replace(/\/+$/, "");
  try {
    if (e.provider === "openai") {
      res = await fetch(/\/v1$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: e.model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } else {
      res = await fetch(`${base}/api/embed`, { method: "POST", headers, body: JSON.stringify({ model: e.model, input: texts }), signal: AbortSignal.timeout(timeoutMs) });
    }
  } catch (err) {
    throw new DonnerError("EMBEDDINGS_UNAVAILABLE", `Cannot reach the embedding service at ${url.origin}: ${err.cause?.code || err.message}`,
      e.provider === "openai" ? "Check embeddings.url." : `Install Ollama (https://ollama.com) and run: ollama pull ${e.model}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || `HTTP ${res.status}`;
    throw new DonnerError("EMBEDDINGS_ERROR", `Embedding request failed: ${msg}`, /not found|pull/i.test(String(msg)) ? `Run: ollama pull ${e.model}` : undefined);
  }
  const vectors = e.provider === "openai" ? (body.data || []).map((d) => d.embedding) : body.embeddings || [];
  if (vectors.length !== texts.length) throw new DonnerError("EMBEDDINGS_ERROR", "Embedding service returned an unexpected response.");
  return vectors.map(normalise);
}

function normalise(v) {
  const f = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}

function docText(row, maxChars) {
  return [row.subject, row.from_name || row.from_addr, row.body, row.att_names].filter(Boolean).join("\n").slice(0, maxChars);
}

export async function checkEmbeddings(cfg) {
  const [v] = await embedTexts(cfg, ["donner"], { timeoutMs: 20000 });
  return `${cfg.embeddings.provider} ${cfg.embeddings.model} (${v.length} dims) at ${cfg.embeddings.url}`;
}

export async function embedAll(db, cfg, { limit = null, rebuild = false, onProgress = () => {}, signal = null } = {}) {
  const e = cfg.embeddings;
  const started = Date.now();
  if (rebuild) db.exec("DELETE FROM embeddings");
  else db.prepare("DELETE FROM embeddings WHERE model != ?").run(e.model);
  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.from_name, m.from_addr, m.body,
         (SELECT group_concat(filename, ', ') FROM attachments a WHERE a.message_id = m.id) AS att_names
       FROM messages m
       WHERE m.content_state IN ('full','parts')
         AND m.id = (SELECT min(id) FROM messages x WHERE x.mid = m.mid)
         AND NOT EXISTS (SELECT 1 FROM embeddings em WHERE em.message_id = m.id)
       ORDER BY m.date DESC ${limit ? "LIMIT " + Number(limit) : ""}`
    )
    .all();
  const { doc } = prefixes(e.model);
  const ins = db.prepare("INSERT OR REPLACE INTO embeddings(message_id, model, dim, vec, created_at) VALUES(?,?,?,?,?)");
  let done = 0;
  const batch = Math.max(1, Math.min(256, e.batchSize || 32));
  for (let i = 0; i < rows.length; i += batch) {
    if (signal?.aborted) break;
    const chunk = rows.slice(i, i + batch);
    const vecs = await embedTexts(cfg, chunk.map((r) => doc + docText(r, e.maxChars || 2000)));
    db.exec("BEGIN");
    try {
      chunk.forEach((r, k) => ins.run(r.id, e.model, vecs[k].length, Buffer.from(vecs[k].buffer), Date.now()));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    done += chunk.length;
    onProgress(done, rows.length);
  }
  const total = db.prepare("SELECT count(*) AS n FROM embeddings").get().n;
  return { embedded: done, remaining: rows.length - done, total, model: e.model, durationMs: Date.now() - started };
}

/** Top-k message ids by cosine similarity, restricted by the query's operators. */
async function semanticIds(db, cfg, query, k) {
  const text = freeText(query);
  if (!text) throw new DonnerError("INVALID_ARGS", "Semantic search needs some words to search for.");
  const have = db.prepare("SELECT count(*) AS n FROM embeddings").get().n;
  if (!have) throw new DonnerError("NO_EMBEDDINGS", "No embeddings yet.", "Run `donner embed` first (needs a local embedding model, see `donner help embed`).");
  const [q] = await embedTexts(cfg, [prefixes(cfg.embeddings.model).query + text]);
  const c = compileQuery(operatorsOnly(query));
  const where = ["e.model = ?", ...c.where];
  if (c.match) {
    // Field-restricted words (subject:x) stay hard filters in semantic mode.
    where.push("m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    c.params.push(c.match);
  }
  const sql = `SELECT e.message_id AS id, e.vec FROM embeddings e JOIN messages m ON m.id = e.message_id
    LEFT JOIN folders f ON f.id = m.folder_id LEFT JOIN accounts ac ON ac.id = m.account_id WHERE ${where.join(" AND ")}`;
  const best = []; // [score, id], kept sorted descending, length ≤ k
  for (const row of db.prepare(sql).iterate(cfg.embeddings.model, ...c.params)) {
    const buf = row.vec;
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (v.length !== q.length) continue;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    if (best.length < k || s > best[best.length - 1][0]) {
      best.push([s, row.id]);
      best.sort((a, b) => b[0] - a[0]);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

export async function semanticSearch(db, cfg, { query, limit = 20, offset = 0, fields, filters = {}, mode = "semantic" }) {
  const want = limit + offset;
  const sem = await semanticIds(db, cfg, query, Math.max(want * 2, 50));
  let ranked;
  if (mode === "hybrid") {
    // Reciprocal rank fusion of keyword and semantic rankings.
    const kw = ops.search(db, { query, limit: Math.max(want * 2, 50), filters, fields: ["id"] }).results.map((r) => r.id);
    const score = new Map();
    kw.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (60 + i)));
    sem.forEach(([, id], i) => score.set(id, (score.get(id) || 0) + 1 / (60 + i)));
    ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  } else ranked = sem.map(([, id]) => id);
  const pageIds = ranked.slice(offset, offset + limit);
  const res = ops.search(db, { query: operatorsOnly(query), ids: pageIds, limit, fields, filters });
  return { ...res, total: ranked.length, offset, sort: mode, hasMore: ranked.length > offset + limit };
}
