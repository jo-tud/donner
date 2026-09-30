// One-command setup and removal: MCP registration in Claude Desktop and Claude Code, the agent
// skill, config changes. Every step is idempotent, so `donner setup` doubles as the update step.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configPath, ensurePrivateDir, writeDefaultConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

export function donnerBin() {
  return realpathSync(join(here, "..", "bin", "donner.js"));
}

// Environment that selects the index/bridge; MCP clients start donner without the user's shell.
const PASS_ENV = ["DONNER_DB", "DONNER_CONFIG", "DONNER_CONFIG_DIR", "DONNER_DATA_DIR", "DONNER_BRIDGE_HOST", "DONNER_BRIDGE_PORT", "TB_BRIDGE_HOST", "TB_BRIDGE_PORT"];

/** How MCP clients should start donner: absolute paths, so nvm/PATH differences do not matter. */
export function mcpServerEntry() {
  const entry = { command: process.execPath, args: [donnerBin(), "mcp"] };
  const env = Object.fromEntries(PASS_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  if (Object.keys(env).length) entry.env = env;
  return entry;
}

export function claudeDesktopConfigPath() {
  const os = platform();
  if (os === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (os === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

/**
 * Add, update or remove the donner entry in Claude Desktop's config. Other settings are kept;
 * the previous file is saved as .bak. Nothing happens when Claude Desktop is not installed.
 * @returns {{status: "added"|"updated"|"unchanged"|"removed"|"absent"|"not-found"|"error", path: string, message?: string}}
 */
export function registerClaudeDesktop({ remove = false } = {}) {
  const path = claudeDesktopConfigPath();
  if (!existsSync(dirname(path))) return { status: "not-found", path };
  let cfg = {};
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, "utf8");
      cfg = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      return { status: "error", path, message: `cannot read ${path} (${err.message}); not changed` };
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { status: "error", path, message: `${path} is not a JSON object; not changed` };
  }
  const servers = cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {};
  let status;
  if (remove) {
    if (!servers.donner) return { status: "absent", path };
    delete servers.donner;
    status = "removed";
  } else {
    const entry = mcpServerEntry();
    if (JSON.stringify(servers.donner) === JSON.stringify(entry)) return { status: "unchanged", path };
    status = servers.donner ? "updated" : "added";
    servers.donner = entry;
  }
  cfg.mcpServers = servers;
  if (existsSync(path)) copyFileSync(path, path + ".bak");
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return { status, path };
}

/**
 * Run the `claude` CLI without a shell. On Windows an npm-installed Claude Code is a
 * `claude.cmd` shim, which Node can only start through cmd.exe; arguments are then quoted, and
 * anything cmd.exe could still interpret (%, ", line breaks) is refused.
 */
function runClaude(args, opts = {}) {
  try {
    return execFileSync("claude", args, opts);
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "ENOENT") throw err;
  }
  if (args.some((a) => /["%\r\n]/.test(a))) throw Object.assign(new Error("argument cannot be passed to claude.cmd safely"), { code: "UNSAFE_ARG" });
  const quoted = args.map((a) => (/[\s&|<>^(),;=]/.test(a) ? `"${a}"` : a));
  return execSync(["claude.cmd", ...quoted].join(" "), opts); // cmd.exe

}

function findClaudeCli() {
  try {
    runClaude(["--version"], { stdio: "ignore", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Register donner with Claude Code (user scope) through its own CLI. */
export function registerClaudeCode({ remove = false } = {}) {
  if (!findClaudeCli()) return { status: "not-found" };
  let had = false;
  try {
    runClaude(["mcp", "remove", "--scope", "user", "donner"], { stdio: "ignore", timeout: 30000 });
    had = true;
  } catch {
    // not registered
  }
  if (remove) return { status: had ? "removed" : "absent" };
  const e = mcpServerEntry();
  // The name goes before -e: -e takes several values and would swallow it.
  const envArgs = Object.entries(e.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  try {
    runClaude(["mcp", "add", "--scope", "user", "donner", ...envArgs, "--", e.command, ...e.args], { stdio: ["ignore", "ignore", "pipe"], timeout: 30000 });
    return { status: had ? "updated" : "added" };
  } catch (err) {
    const why = String(err.stderr || "").trim().split("\n")[0] || err.message.split("\n")[0];
    return { status: "error", message: `claude mcp add failed: ${why.slice(0, 200)}` };
  }
}

export function skillSource() {
  return join(here, "..", "skills", "donner", "SKILL.md");
}

export function skillTarget(dir) {
  return join(dir || join(homedir(), ".claude", "skills"), "donner", "SKILL.md");
}

/** Install or update the Claude Code skill (only where Claude Code is present). */
export function installSkill({ remove = false, onlyIfClaude = true } = {}) {
  const target = skillTarget();
  if (remove) {
    if (!existsSync(target)) return { status: "absent", path: target };
    rmSync(dirname(target), { recursive: true, force: true });
    return { status: "removed", path: target };
  }
  if (onlyIfClaude && !existsSync(join(homedir(), ".claude")) && !findClaudeCli()) return { status: "not-found", path: target };
  const src = readFileSync(skillSource());
  if (existsSync(target) && readFileSync(target).equals(src)) return { status: "unchanged", path: target };
  const status = existsSync(target) ? "updated" : "added";
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, src);
  return { status, path: target };
}

/** Add addresses to index.myAddresses in the donner config file (created if missing). */
export function addMyAddresses(addrs) {
  const path = configPath();
  if (!existsSync(path)) writeDefaultConfig();
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw Object.assign(new Error(`Cannot read ${path} (${err.message}); add the addresses to index.myAddresses by hand.`), { code: "CONFIG_ERROR" });
  }
  cfg.index = cfg.index && typeof cfg.index === "object" ? cfg.index : {};
  const list = Array.isArray(cfg.index.myAddresses) ? cfg.index.myAddresses : [];
  for (const a of addrs) if (!list.some((x) => String(x).toLowerCase() === a.toLowerCase())) list.push(a);
  cfg.index.myAddresses = list;
  ensurePrivateDir(dirname(path));
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return { path, myAddresses: list };
}
