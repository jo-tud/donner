// Output: JSON for agents and pipes, readable text for humans at a terminal.

const env = process.env;

export function wantColor(stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY;
}

export function makeStyle(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

/** Terminal width, bounded. */
export function termWidth() {
  return Math.max(60, Math.min(process.stdout.columns || 100, 160));
}

/** Pad/truncate a string to a visible width (no ANSI inside). */
export function fit(s, width) {
  const str = String(s ?? "").replace(/\s+/g, " ");
  const chars = [...str];
  if (chars.length > width) return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
  return str + " ".repeat(width - chars.length);
}

/** Replace control characters so mail content cannot inject terminal escape sequences. */
export function safeTerm(s) {
  return String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => (c === "\u0001" || c === "\u0002" ? c : "�"));
}

export function shortDate(iso) {
  if (!iso) return "          ";
  return iso.slice(0, 10);
}

export function printJson(data, { pretty = false } = {}) {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, pretty ? 2 : 0) + "\n");
}

export function printError(err, { json }) {
  if (json) {
    const e = { ok: false, error: { code: err.code || "ERROR", message: err.message } };
    if (err.hint) e.error.hint = err.hint;
    process.stderr.write(JSON.stringify(e) + "\n");
    return;
  }
  const st = makeStyle(wantColor(process.stderr));
  process.stderr.write(`${st.red("error")}: ${err.message}${err.code && err.code !== "ERROR" ? st.dim(` [${err.code}]`) : ""}\n`);
  if (err.hint) process.stderr.write(`${st.dim("hint")}: ${err.hint}\n`);
  if (env.DONNER_DEBUG && err.stack) process.stderr.write(st.dim(err.stack) + "\n");
}

export function table(rows, columns, st) {
  if (!rows.length) return "";
  const widths = columns.map((c) => Math.min(c.max || 60, Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? "").length))));
  const head = columns.map((c, i) => st.bold(fit(c.label, widths[i]))).join("  ");
  const body = rows.map((r) => columns.map((c, i) => (c.align === "right" ? String(r[c.key] ?? "").padStart(widths[i]) : fit(safeTerm(r[c.key] ?? ""), widths[i]))).join("  "));
  return [head, ...body].join("\n");
}
