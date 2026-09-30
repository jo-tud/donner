// Read-only ad-hoc SQL for agents.
//
// Defence in depth:
//   1. static check: exactly one SELECT/WITH/VALUES/EXPLAIN statement, no writes,
//      ATTACH, PRAGMA, VACUUM INTO or extension loading
//   2. the query runs in a separate process on a read-only connection with query_only=ON
//   3. that process is killed after a timeout; rows and cell sizes are capped

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DonnerError } from "./errors.js";

const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|VACUUM|INSERT|UPDATE|DELETE|REPLACE\s+INTO|UPSERT|CREATE|DROP|ALTER|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|load_extension|readfile|writefile|fts3_tokenizer|sqlite_dbpage|zipfile|fsdir)\b/i;

/** Remove comments and literals so keyword checks cannot be fooled by quoting. */
export function sqlSkeleton(sql) {
  let out = "";
  let i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "-" && n === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && n === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      out += " ";
      continue;
    }
    if (c === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
      continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      // Quoted identifiers: keep as a neutral identifier.
      const close = c === "[" ? "]" : c;
      const start = i;
      i++;
      while (i < s.length) {
        if (s[i] === close && s[i + 1] === close && close !== "]") i += 2;
        else if (s[i] === close) break;
        else i++;
      }
      const ident = s.slice(start + 1, Math.min(i, s.length));
      i++;
      // Keep identifier text visible for the function blocklist ("load_extension"(...)).
      out += ` ident_${ident.replace(/[^A-Za-z0-9_]/g, "_")} `;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function validateSql(sql) {
  if (!sql || !String(sql).trim()) throw new DonnerError("INVALID_ARGS", "Empty SQL query.");
  const sk = sqlSkeleton(sql).trim().replace(/;\s*$/, "");
  if (sk.includes(";")) throw new DonnerError("SQL_REJECTED", "Only a single statement is allowed.");
  const first = sk.match(/^\s*\(?\s*([a-zA-Z]+)/)?.[1]?.toUpperCase();
  if (!["SELECT", "WITH", "VALUES", "EXPLAIN"].includes(first)) {
    throw new DonnerError("SQL_REJECTED", "Only read-only queries (SELECT / WITH / VALUES / EXPLAIN) are allowed.");
  }
  const fn = sk.match(/\bident_(load_extension|readfile|writefile|fts3_tokenizer|sqlite_dbpage|zipfile|fsdir)\b/i);
  if (fn) throw new DonnerError("SQL_REJECTED", `"${fn[1]}" is not allowed in donner sql (read-only).`);
  const bad = sk.match(FORBIDDEN);
  if (bad) throw new DonnerError("SQL_REJECTED", `"${bad[1]}" is not allowed in donner sql (read-only).`);
  // Bound parameters are never needed, and SQLite's "$name(...)" parameter syntax can hide
  // quotes from this check. Reject every parameter form outright.
  if (/[$@?]|:[A-Za-z_0-9]/.test(sk)) throw new DonnerError("SQL_REJECTED", "Query parameters ($x, :x, @x, ?) are not supported; write values inline.");
  return true;
}

const here = dirname(fileURLToPath(import.meta.url));

const MEMORY_MB = Number(process.env.DONNER_SQL_MEMORY_MB) || 1536;

/**
 * Start the SQL child. On POSIX its address space is capped with `ulimit -v`, so a query
 * that tries to materialise huge values fails with "out of memory" inside SQLite instead of
 * exhausting the machine. Paths are passed as arguments, never interpolated into the script.
 */
function spawnLimited(script) {
  const env = { ...process.env, NODE_OPTIONS: "" };
  if (process.platform !== "win32" && MEMORY_MB > 0) {
    const kb = String(Math.floor(MEMORY_MB * 1024));
    return spawn("/bin/sh", ["-c", 'ulimit -v "$1" 2>/dev/null; shift; exec "$@"', "sh", kb, process.execPath, "--no-warnings", script], { stdio: ["pipe", "pipe", "pipe"], env });
  }
  return spawn(process.execPath, ["--no-warnings", script], { stdio: ["pipe", "pipe", "pipe"], env });
}

// One query at a time per process (the MCP server may receive many in parallel).
let queue = Promise.resolve();

/**
 * Run a read-only query in a child process.
 * @returns {Promise<{columns: string[], rows: object[], truncated: boolean, ms: number}>}
 */
export function runSql(dbPath, sql, opts = {}) {
  validateSql(sql);
  const run = queue.then(() => runSqlNow(dbPath, sql, opts));
  queue = run.catch(() => {});
  return run;
}

function runSqlNow(dbPath, sql, { maxRows = 500, maxCell = 2000, timeoutMs = 15000, params = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnLimited(join(here, "sql-child.js"));
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new DonnerError("SQL_TIMEOUT", `Query took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`, "Add a LIMIT, filter with WHERE, or use the full-text index (messages_fts MATCH ...)."));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 64 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let msg;
      try {
        msg = JSON.parse(out);
      } catch {
        const oom = /out of memory|Failed to reserve/i.test(err);
        reject(new DonnerError(oom ? "SQL_TOO_BIG" : "SQL_ERROR", oom ? "The query needed too much memory and was stopped." : `SQL process failed: ${err.trim().slice(0, 500) || "no output"}`, oom ? "Select fewer or smaller values (use LIMIT, substr())." : undefined));
        return;
      }
      if (msg.error) reject(new DonnerError(msg.code || "SQL_ERROR", msg.error, msg.hint));
      else resolve(msg);
    });
    // The child may die before reading its input (e.g. memory limit); EPIPE must not crash us.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ dbPath, sql, params, maxRows, maxCell }));
  });
}
