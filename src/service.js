// Background service helpers: systemd (Linux), launchd (macOS), Task Scheduler hint (Windows).

import { writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LABEL = "io.github.jo-tud.donner";

// Service manager calls (systemctl/launchctl). DONNER_NO_SERVICE_MANAGER=1 only writes and
// removes the files, e.g. in tests or when a packager manages the service.
function manage(cmd, args) {
  if (process.env.DONNER_NO_SERVICE_MANAGER === "1") throw Object.assign(new Error("service manager disabled"), { code: "DISABLED" });
  return execFileSync(cmd, args, { stdio: "ignore" });
}

function donnerBin() {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "donner.js"));
}

// Environment that decides which index/bridge donner uses; the service must see the same.
// Tokens are deliberately not copied into service files.
const PASS_ENV = ["DONNER_DB", "DONNER_CONFIG", "DONNER_CONFIG_DIR", "DONNER_DATA_DIR", "DONNER_BRIDGE_HOST", "DONNER_BRIDGE_PORT", "TB_BRIDGE_HOST", "TB_BRIDGE_PORT", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];

function passEnv() {
  return PASS_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]);
}

/** systemd quoting: "…" with \ and " escaped, % doubled (specifiers). */
function sq(v) {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function xml(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function systemdUnit(interval) {
  const env = passEnv().map(([k, v]) => `Environment=${sq(`${k}=${v}`)}\n`).join("");
  return `[Unit]
Description=donner — keep the Thunderbird mail index fresh
After=network-online.target

[Service]
Type=simple
${env}ExecStart=${sq(process.execPath)} ${sq(donnerBin())} watch --interval ${sq(interval)} --quiet
Restart=on-failure
RestartSec=60
Nice=10
IOSchedulingClass=idle
# Hardening: donner only needs its own data dir and the local bridge.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function launchdPlist(interval) {
  const log = join(homedir(), "Library", "Logs", "donner.log");
  const env = passEnv();
  const envXml = env.length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(donnerBin())}</string>
    <string>watch</string>
    <string>--interval</string>
    <string>${xml(interval)}</string>
    <string>--quiet</string>
  </array>
${envXml}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export async function serviceCommand(sub, { interval }) {
  const os = platform();
  if (!/^\d+\s*(s|min|h)$/.test(interval)) throw Object.assign(new Error(`--interval must look like 10min or 1h (got "${interval}")`), { code: "INVALID_ARGS" });
  if (os === "linux") {
    const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", "donner.service");
    if (sub === "print") return { path, unit: systemdUnit(interval), message: `# ${path}\n${systemdUnit(interval)}\n# install with: donner service install` };
    if (sub === "install") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, systemdUnit(interval), { mode: 0o600 });
      let enabled = false;
      try {
        manage("systemctl", ["--user", "daemon-reload"]);
        manage("systemctl", ["--user", "enable", "--now", "donner.service"]);
        // Pick up a new donner version or changed settings if it was already running.
        manage("systemctl", ["--user", "restart", "donner.service"]);
        enabled = true;
      } catch {
        // systemd user session not available (e.g. container); the file is still written
      }
      return {
        path,
        enabled,
        message: enabled
          ? `installed and started ${path}\nlogs: journalctl --user -u donner -f`
          : `wrote ${path}\nstart it with: systemctl --user enable --now donner.service`,
      };
    }
    if (sub === "stop") {
      try {
        manage("systemctl", ["--user", "stop", "donner.service"]);
        return { path, stopped: true, message: "stopped donner.service" };
      } catch {
        return { path, stopped: false, message: "donner.service is not running" };
      }
    }
    if (sub === "uninstall") {
      try {
        manage("systemctl", ["--user", "disable", "--now", "donner.service"]);
      } catch {
        // not running
      }
      if (existsSync(path)) rmSync(path);
      return { path, message: `removed ${path}` };
    }
  } else if (os === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    if (sub === "print") return { path, plist: launchdPlist(interval), message: `# ${path}\n${launchdPlist(interval)}` };
    if (sub === "install") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, launchdPlist(interval), { mode: 0o600 });
      let loaded = false;
      try {
        manage("launchctl", ["unload", path]); // reload a running agent
      } catch {
        // not loaded
      }
      try {
        manage("launchctl", ["load", "-w", path]);
        loaded = true;
      } catch {
        // already loaded or launchctl unavailable
      }
      return { path, loaded, message: `${loaded ? "installed and loaded" : "wrote"} ${path}\nlogs: ~/Library/Logs/donner.log` };
    }
    if (sub === "stop") {
      try {
        manage("launchctl", ["unload", path]);
        return { path, stopped: true, message: "stopped the donner agent" };
      } catch {
        return { path, stopped: false, message: "the donner agent is not running" };
      }
    }
    if (sub === "uninstall") {
      try {
        manage("launchctl", ["unload", "-w", path]);
      } catch {
        // not loaded
      }
      if (existsSync(path)) rmSync(path);
      return { path, message: `removed ${path}` };
    }
  } else if (os === "win32") {
    const cmd = `schtasks /Create /SC ONLOGON /TN donner /TR "\\"${process.execPath}\\" \\"${donnerBin()}\\" watch --interval ${interval} --quiet"`;
    return { command: cmd, message: `Run this in a terminal to start donner at logon:\n  ${cmd}\nRemove with: schtasks /Delete /TN donner /F` };
  }
  if (sub === "stop") return { stopped: false, message: "no background service on this system" };
  if (!["print", "install", "uninstall"].includes(sub)) {
    throw Object.assign(new Error(`Unknown service subcommand "${sub}". Use print, install or uninstall.`), { code: "INVALID_ARGS" });
  }
  return { message: `Background services are not supported on ${os}; run \`donner watch\` instead.` };
}
