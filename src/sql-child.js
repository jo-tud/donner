// Child process for `donner sql`: executes one read-only query and prints JSON.

import { DatabaseSync } from "./sqlite.js";
import { validateSql } from "./sql.js";

function cell(v, maxCell) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  if (typeof v === "string" && v.length > maxCell) return v.slice(0, maxCell) + `… [+${v.length - maxCell} chars]`;
  return v;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const started = Date.now();
  try {
    const { dbPath, sql, params, maxRows, maxCell } = JSON.parse(input);
    validateSql(sql);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    // Cap the classic memory-bomb functions (defence in depth; the process is also rlimited).
    const cap = 10 * 1024 * 1024;
    const blob = (n) => {
      if (Number(n) > cap) throw new Error("value too large");
      return new Uint8Array(Math.max(0, Number(n) || 0));
    };
    db.function("zeroblob", { deterministic: true }, blob);
    db.function("randomblob", { deterministic: false }, (n) => {
      const b = blob(n);
      for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0;
      return b;
    });
    const stmt = db.prepare(sql);
    const rows = [];
    let truncated = false;
    let columns = null;
    for (const r of stmt.iterate(...(params || []))) {
      if (!columns) columns = Object.keys(r);
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const o = {};
      for (const k of columns) o[k] = cell(r[k], maxCell);
      rows.push(o);
    }
    if (!columns) {
      try {
        columns = stmt.columns().map((c) => c.name);
      } catch {
        columns = [];
      }
    }
    process.stdout.write(JSON.stringify({ columns, rows, truncated, ms: Date.now() - started }));
  } catch (err) {
    const msg = /out of memory/i.test(err.message) ? "The query needed too much memory and was stopped." : err.message;
    process.stdout.write(JSON.stringify({ error: msg, code: err.code && /^[A-Z_]+$/.test(err.code) && !err.code.startsWith("ERR_") ? err.code : "SQL_ERROR", hint: err.hint }));
  }
});
