// `donner setup` / `donner uninstall` in a sandboxed home directory.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { setupIndexed, runCli, tempDir, BIN } from "../helpers.js";

let env;
let home;
let run;
const log = () => (existsSync(join(home, "claude.log")) ? readFileSync(join(home, "claude.log"), "utf8") : "");

// Where donner setup looks for Claude Desktop's config, for a given home directory.
const desktopDir = (home) =>
  process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude")
  : process.platform === "win32" ? join(home, "AppData", "Roaming", "Claude")
  : join(home, ".config", "Claude");
const serviceFile = (home) =>
  process.platform === "darwin" ? join(home, "Library", "LaunchAgents", "io.github.jo-tud.donner.plist")
  : process.platform === "linux" ? join(home, ".config", "systemd", "user", "donner.service")
  : null; // Windows: setup prints a Task Scheduler command instead

before(async () => {
  env = await setupIndexed({ count: 150, sync: false });
  home = tempDir("donner-home-");
  // Claude Desktop with existing settings, Claude Code with a stub CLI that records its calls.
  mkdirSync(desktopDir(home), { recursive: true });
  writeFileSync(join(desktopDir(home), "claude_desktop_config.json"), JSON.stringify({ preferences: { keep: true } }));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, "bin"));
  const logFile = join(home, "claude.log");
  if (process.platform === "win32") {
    writeFileSync(join(home, "bin", "claude.cmd"), `@echo off\r\necho %*>> "${logFile}"\r\necho %* | findstr /b /c:"mcp remove" >nul && (findstr /c:"mcp add" "${logFile}" >nul || exit /b 1)\r\nexit /b 0\r\n`);
  } else {
    const stub = join(home, "bin", "claude");
    writeFileSync(stub, `#!/bin/sh\necho "$*" >> "${logFile}"\ncase "$*" in "mcp remove"*) grep -q "mcp add" "${logFile}" || exit 1;; esac\nexit 0\n`);
    chmodSync(stub, 0o755);
  }
  const e = { ...env.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), PATH: `${join(home, "bin")}${delimiter}${process.env.PATH}`, DONNER_NO_SERVICE_MANAGER: "1" };
  delete e.XDG_CONFIG_HOME;
  run = (args) => runCli(args, { env: e, timeoutMs: 120000 });
});
after(async () => {
  await env?.cleanup();
});

test("setup: registers Claude Desktop and Claude Code, installs the skill, builds the index", async () => {
  const r = await run(["setup", "--yes", "--no-service"]);
  assert.equal(r.code, 0, r.stderr);
  const steps = Object.fromEntries(r.json.data.steps.map((s) => [s.name, s]));
  assert.equal(steps.thunderbird.status, "ok");
  assert.equal(steps["claude desktop"].status, "ok");
  assert.equal(steps["claude code"].status, "ok");
  assert.equal(steps.skill.status, "ok");
  assert.equal(steps.index.status, "ok");
  assert.equal(steps.service.status, "skip");
  assert.match(steps["my addresses"].detail, /anna\.schmidt@altmail\.example/, "suggested, not added (--yes)");

  const desktop = JSON.parse(readFileSync(join(desktopDir(home), "claude_desktop_config.json"), "utf8"));
  assert.deepEqual(desktop.preferences, { keep: true }, "other settings are kept");
  assert.equal(desktop.mcpServers.donner.command, process.execPath, "absolute node path (nvm-safe)");
  assert.deepEqual(desktop.mcpServers.donner.args, [BIN, "mcp"]);
  assert.equal(desktop.mcpServers.donner.env.DONNER_DB, env.dbPath);
  assert.ok(existsSync(join(desktopDir(home), "claude_desktop_config.json.bak")));
  assert.match(log(), /mcp add --scope user donner (-e \S+ )*-- \S+ \S+donner\.js"? mcp/);
  assert.equal(readFileSync(join(home, ".claude", "skills", "donner", "SKILL.md"), "utf8"), readFileSync(join(BIN, "..", "..", "skills", "donner", "SKILL.md"), "utf8"));

  const s = await run(["status"]);
  assert.ok(s.json.data.messages > 100);
});

test("setup again is an update: nothing duplicated, service file written", async () => {
  const r = await run(["setup", "--yes", "--no-sync"]);
  const steps = Object.fromEntries(r.json.data.steps.map((s) => [s.name, s]));
  assert.match(steps["claude desktop"].detail, /already registered/);
  assert.match(steps.skill.detail, /up to date/);
  assert.equal(steps["claude code"].detail, "updated the donner MCP server (user scope)");
  if (serviceFile(home)) assert.ok(existsSync(serviceFile(home)), "service file written (service manager disabled in tests)");
  assert.equal(r.json.data.next.some((n) => /Restart Claude Desktop/.test(n)), false);
});

test("uninstall removes registrations, skill and service; --purge needs --yes", async () => {
  const bad = await run(["uninstall", "--purge"]);
  assert.equal(bad.code, 2);
  const r = await run(["uninstall"]);
  assert.equal(r.code, 0, r.stderr);
  const desktop = JSON.parse(readFileSync(join(desktopDir(home), "claude_desktop_config.json"), "utf8"));
  assert.equal(desktop.mcpServers.donner, undefined);
  assert.deepEqual(desktop.preferences, { keep: true });
  assert.ok(!existsSync(join(home, ".claude", "skills", "donner", "SKILL.md")));
  if (serviceFile(home)) assert.ok(!existsSync(serviceFile(home)));
  assert.match(log(), /mcp remove --scope user donner/);
  assert.ok(existsSync(env.dbPath), "the index stays without --purge");
  env.db.close(); // Windows cannot delete a file this test process still has open
  const p = await run(["uninstall", "--purge", "--yes"]);
  assert.equal(p.code, 0);
  assert.ok(!existsSync(env.dbPath));
});
