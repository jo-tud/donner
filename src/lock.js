// Single-writer lock so two `donner sync` runs never interleave.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { DonnerError } from "./errors.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let info = null;
      try {
        info = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // corrupt / half-written lock: treat as stale
      }
      if (info?.pid && info.pid !== process.pid && alive(info.pid)) {
        throw new DonnerError("SYNC_RUNNING", `Another donner sync is running (pid ${info.pid}, since ${info.started}).`,
          "Wait for it to finish, or stop it. Searching works in the meantime.");
      }
      try {
        unlinkSync(path);
      } catch {
        // raced with another process; retry
      }
    }
  }
  throw new DonnerError("SYNC_RUNNING", "Could not acquire the sync lock.");
}
