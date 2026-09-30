// Lightweight static checks without dependencies: every source file parses, no stray
// console.log in src/, and no stdout writes from the MCP server path except the protocol.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "vendor") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (err) {
    failed++;
    console.error(`syntax error in ${relative(root, f)}:\n${err.stderr}`);
  }
  const rel = relative(root, f);
  if (rel.startsWith("src")) {
    const src = readFileSync(f, "utf8");
    if (/console\.log\(/.test(src)) {
      failed++;
      console.error(`${rel}: console.log in library code (stdout is reserved for JSON / MCP)`);
    }
  }
}
console.error(`${files.length} files checked, ${failed} problem(s)`);
process.exit(failed ? 1 : 0);
