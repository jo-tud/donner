// Ephemeral GnuPG homes and PGP/MIME fixtures for the tests.
//
// Every helper here creates its own GNUPGHOME in a temp directory and removes it again.
// The user's real keyring is NEVER touched: gpg only ever sees the throwaway home passed
// in via the environment.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let sharedHome = null;

/**
 * Process-wide throwaway keyring for corpus fixtures (integration tests, demo, bench).
 * Created lazily when gpg is installed and removed when the process exits; the user's real
 * keyring is never involved.
 */
export function sharedGpgHome() {
  if (!sharedHome) {
    sharedHome = makeGpgHome();
    process.on("exit", () => {
      try {
        sharedHome?.cleanup();
      } catch {
        // best effort
      }
    });
  }
  return sharedHome;
}

const TEST_UID = "Donner Test <donner-test@invalid>";

/** Temp GNUPGHOME with one RSA test key (no passphrase). Returns {home, cleanup}. */
export function makeGpgHome({ withKey = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "donner-gpg-"));
  const cleanup = () => {
    // Stop the throwaway gpg-agent before removing its home.
    spawnSync("gpgconf", ["--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: home }, stdio: "ignore", timeout: 10000 });
    rmSync(home, { recursive: true, force: true });
  };
  if (withKey) {
    const r = spawnSync("gpg", ["--batch", "--passphrase", "", "--quick-generate-key", TEST_UID, "rsa2048", "encrypt,sign", "never"], {
      env: { ...process.env, GNUPGHOME: home },
      stdio: "ignore",
      timeout: 60000,
    });
    if (r.error || r.status !== 0) {
      cleanup();
      throw new Error(`test key generation failed: ${r.error || `gpg exited ${r.status}`}`);
    }
  }
  return { home, cleanup };
}

function runGpg(home, args, input) {
  const r = spawnSync("gpg", ["--batch", "--no-tty", "--trust-model", "always", ...args], {
    env: { ...process.env, GNUPGHOME: home },
    input,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  if (r.error || r.status !== 0) throw new Error(`gpg ${args.join(" ")} failed: ${r.error || `exit ${r.status}: ${r.stderr}`}`);
  return r.stdout;
}

/** Encrypt to the test key of `home`. Returns armored ciphertext (string) or binary (Buffer). */
export function encrypt(plain, home, { armor = true } = {}) {
  const args = [...(armor ? ["--armor"] : []), "--encrypt", "--recipient", TEST_UID];
  return runGpg(home, args, Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), "utf8"));
}

/** Fingerprint of the (only) primary key in `home`, secret or public. */
export function fingerprint(home, { secret = true } = {}) {
  const out = runGpg(home, ["--with-colons", secret ? "--list-secret-keys" : "--list-keys"]).toString("utf8");
  return out.split("\n").find((l) => l.startsWith("fpr:"))?.split(":")[9];
}

/**
 * Sign with the key of `signerHome` and encrypt to the key of `recipientHome`, with the
 * signer's public key embedded in the signature (--include-key-block). The recipient's
 * keyring does not know the signer — what a mail from a stranger looks like.
 */
export function signEncrypt(plain, signerHome, recipientHome) {
  const recipient = fingerprint(recipientHome);
  runGpg(signerHome, ["--import"], runGpg(recipientHome, ["--export", recipient]));
  const args = ["--armor", "--include-key-block", "--local-user", fingerprint(signerHome), "--recipient", recipient, "--sign", "--encrypt"];
  return runGpg(signerHome, args, Buffer.from(String(plain), "utf8")).toString("utf8");
}

/**
 * Build a PGP/MIME message (RFC 3156/8551): multipart/encrypted with the encrypted
 * payload as second part. `inner` is the plaintext MIME entity (usually buildMessage output).
 */
export function buildPgpMime(inner, cipher, outerHeaders = {}) {
  const lines = outerHeaderLines(outerHeaders);
  const b = "----=_donner_test_pgp_mime";
  lines.push(`Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`);
  lines.push("");
  lines.push(`--${b}`);
  lines.push("Content-Type: application/pgp-encrypted");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push("Version: 1");
  lines.push(`--${b}`);
  lines.push('Content-Type: application/octet-stream; name="encrypted.asc"');
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  const body = Buffer.isBuffer(cipher) ? cipher.toString("utf8") : String(cipher);
  lines.push(body.trimEnd());
  lines.push(`--${b}--`);
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf8");
}

/** A plain text/plain message whose body is one armored PGP message (inline PGP). */
export function buildInlinePgp(cipher, outerHeaders = {}) {
  const lines = outerHeaderLines(outerHeaders);
  lines.push('Content-Type: text/plain; charset="utf-8"');
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(String(cipher).trimEnd());
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf8");
}

function outerHeaderLines(outerHeaders) {
  const lines = [];
  for (const [k, v] of Object.entries(outerHeaders.headers || {})) lines.push(`${k}: ${v}`);
  if (outerHeaders.from) lines.push(`From: ${outerHeaders.from}`);
  if (outerHeaders.to) lines.push(`To: ${outerHeaders.to}`);
  if (outerHeaders.subject !== undefined) lines.push(`Subject: ${outerHeaders.subject}`);
  if (outerHeaders.date) lines.push(`Date: ${outerHeaders.date}`);
  if (outerHeaders.messageId) lines.push(`Message-ID: <${outerHeaders.messageId}>`);
  lines.push("MIME-Version: 1.0");
  return lines;
}
