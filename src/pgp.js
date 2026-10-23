// PGP decryption (PGP/MIME and inline PGP) with the local GnuPG binary.
//
// Like `pdftotext` in pdf.js, gpg is an optional local helper: when it is missing, no secret
// key matches, or the gpg-agent passphrase cache is empty, the message is indexed without its
// content, marked as encrypted and retried by a later sync. Security properties:
//
//  - gpg runs as a local child process of the parser: ciphertext goes in on stdin, plaintext
//    comes out on stdout. Nothing is written to disk, nothing leaves the machine.
//  - No passphrase handling at all: `--batch --no-tty --pinentry-mode error` never prompts
//    (no pinentry popup, no hang) and no passphrase is ever passed in argv or logged.
//  - Secret-key material is never read or exported; the only key operation is decrypt (the
//    doctor's `countSecretKeys` reads colon-listing metadata, never key material).
//  - No network and no keyring changes: keyserver lookups and key imports that the user's
//    gpg.conf may enable are switched off for the decryption (see decryptArgs).
//  - Failures are classified from gpg's machine-readable status lines (`--status-fd`), never
//    from the (localised) stderr text.

import { spawn, spawnSync } from "node:child_process";

let gpgAvailable;
let gpgOptions = null;

/** Is a gpg binary on PATH? Set DONNER_NO_GPG=1 to pretend there is none. */
export function hasGpg() {
  if (process.env.DONNER_NO_GPG) return false;
  if (gpgAvailable === undefined) {
    try {
      const r = spawnSync("gpg", ["--dump-options"], { encoding: "utf8", timeout: 5000, shell: false });
      gpgAvailable = !r.error;
      gpgOptions = new Set(String(r.stdout || "").split("\n").map((l) => l.trim()));
    } catch {
      gpgAvailable = false;
    }
  }
  return gpgAvailable;
}

// The user's gpg.conf may enable auto-key-retrieve or auto-key-import. Decrypting a signed
// mail would then contact a keyserver (a read receipt for the sender, triggered in the
// background) or add the sender's key to the keyring. Indexing must do neither. Only options
// this gpg knows are passed, so older versions still decrypt.
const HARDENING = ["--disable-dirmngr", "--no-auto-key-retrieve", "--no-auto-key-import", "--no-auto-key-locate"];

/** The gpg arguments for one decryption (exported for tests). */
export function decryptArgs() {
  hasGpg();
  const hardening = HARDENING.filter((o) => !gpgOptions || gpgOptions.has(o));
  return ["--batch", "--no-tty", "--pinentry-mode", "error", ...hardening, "--status-fd", "2", "--decrypt"];
}

/** Number of secret keys in the keyring (metadata count only — key material is never read). */
export function countSecretKeys() {
  if (!hasGpg()) return 0;
  try {
    const r = spawnSync("gpg", ["--batch", "--list-secret-keys", "--with-colons"], { encoding: "utf8", timeout: 5000, shell: false });
    return String(r.stdout || "").split("\n").filter((l) => l.startsWith("sec:")).length;
  } catch {
    return 0;
  }
}

export const ARMOR_BEGIN = "-----BEGIN PGP MESSAGE-----";
export const ARMOR_END = "-----END PGP MESSAGE-----";

/**
 * The armored ciphertext in a text (inline PGP), or null.
 * Found with indexOf (linear), never with a greedy regex.
 */
export function findArmored(s) {
  if (!s) return null;
  const a = s.indexOf(ARMOR_BEGIN);
  if (a < 0 || s.length > 100 * 1024 * 1024) return null;
  const b = s.indexOf(ARMOR_END, a);
  if (b < 0) return null;
  return s.slice(a, b + ARMOR_END.length);
}

/** RFC 3156/8551 PGP/MIME: multipart/encrypted with the pgp-encrypted protocol. */
export function isPgpMime(contentType) {
  const ct = String(contentType || "").toLowerCase();
  return ct.startsWith("multipart/encrypted");
}

/** A PGP attachment (.gpg/.pgp/.asc) or an armored PGP message, detected by name and content. */
export function isPgpAttachment(filename, contentType, head) {
  const name = String(filename || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();
  if (/\.(gpg|pgp|asc)$/.test(name)) return true;
  if (type === "application/pgp-encrypted") return true;
  const h = typeof head === "string" ? head.slice(0, 300) : head ? Buffer.from(head).subarray(0, 300).toString("latin1") : "";
  return h.includes(ARMOR_BEGIN);
}

/** "contract.pdf.gpg" → "contract.pdf" (so the decrypted content is extracted as usual). */
export function stripCryptoSuffix(filename) {
  return String(filename || "").replace(/\.(gpg|pgp|asc)$/i, "") || "decrypted";
}

/**
 * Classify a gpg failure from the `[GNUPG:]` status lines on fd 2.
 * @returns {string} a short reason for logs and `donner show`
 */
function classify(status, stderr, timedOut) {
  if (timedOut) return "gpg timed out";
  if (/^\[GNUPG:\] NO_SECKEY /m.test(status)) return "no matching secret key in the local keyring";
  if (/^\[GNUPG:\] (BAD_PASSPHRASE|MISSING_PASSPHRASE|PINENTRY_LAUNCHED|NO_PINENTRY)/m.test(status))
    return "the gpg-agent passphrase cache is empty — unlock it once with `gpg --decrypt`";
  if (/^\[GNUPG:\] (DECRYPTION_FAILED|ERROR )/m.test(status) || !/^\[GNUPG:\] DECRYPTION_OKAY/m.test(status)) {
    const tail = String(stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 200);
    return tail ? `the message could not be decrypted (${tail})` : "the message could not be decrypted (corrupt or truncated)";
  }
  return "the message could not be decrypted";
}

/**
 * Decrypt ciphertext with the local gpg. Never throws: the caller decides what a failure
 * means (index without content, retry later).
 *
 * @param {Buffer|string} cipher armored or binary OpenPGP data
 * @returns {Promise<{ok: true, buf: Buffer} | {ok: false, error: string}>}
 */
export function decryptGpg(cipher, { timeoutMs = 15000, maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!hasGpg()) return Promise.resolve({ ok: false, error: "gpg is not installed" });
  const input = Buffer.isBuffer(cipher) ? cipher : Buffer.from(String(cipher), "utf8");
  return new Promise((resolve) => {
    const args = decryptArgs();
    const opts = { stdio: ["pipe", "pipe", "pipe"], shell: false };
    const child =
      process.platform === "win32"
        ? spawn("gpg", args, opts)
        : spawn("/bin/sh", ["-c", 'ulimit -v "$1" 2>/dev/null; shift; exec "$@"', "sh", "1048576", "gpg", ...args], opts);
    const chunks = [];
    const errChunks = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (c) => {
      if (errChunks.reduce((n, x) => n + x.length, 0) < 64 * 1024) errChunks.push(c);
    });
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.on("error", () => done({ ok: false, error: "gpg could not be started" }));
    child.on("close", (code) => {
      const status = Buffer.concat(errChunks).toString("utf8");
      if (size > maxBytes) return done({ ok: false, error: "the decrypted content is too large" });
      // gpg exits non-zero when it cannot verify a signature (e.g. the sender's public key is
      // not in the keyring) even though the decryption itself succeeded. DECRYPTION_OKAY is
      // the authoritative signal; integrity failures are reported as DECRYPTION_FAILED.
      const decrypted = /^\[GNUPG:\] DECRYPTION_OKAY/m.test(status) && !/^\[GNUPG:\] DECRYPTION_FAILED/m.test(status);
      if (!timedOut && (code === 0 || decrypted)) return done({ ok: true, buf: Buffer.concat(chunks) });
      done({ ok: false, error: classify(status, status.replace(/\[GNUPG:\][^\n]*\n?/g, ""), timedOut) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
