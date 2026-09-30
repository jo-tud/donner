// Loads Node's built-in SQLite without printing the "experimental" warning on every run.
// Using node:sqlite keeps donner free of native build steps.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const text = typeof warning === "string" ? warning : warning?.message || "";
    const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return original.call(process, warning, ...args);
  };
  try {
    return require("node:sqlite");
  } catch (err) {
    const e = new Error(
      `donner needs Node.js >= 22.13 (built-in SQLite). You are running ${process.version}. ` +
        "Install a current Node.js LTS from https://nodejs.org and try again."
    );
    e.code = "NODE_TOO_OLD";
    e.cause = err;
    throw e;
  } finally {
    process.emitWarning = original;
  }
}

export const { DatabaseSync } = loadSqlite();
