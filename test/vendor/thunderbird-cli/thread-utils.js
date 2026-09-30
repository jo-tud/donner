/**
 * Pure helpers for email thread reconstruction.
 *
 * Loaded as a background script before background.js (see manifest.json), so these are plain
 * globals rather than ES exports. test/thread-utils.test.mjs loads this file in a Node vm.
 */

/**
 * Read a named header from an RFC 2822 message. Only the header block is scanned, and folded
 * (multi-line) headers are unfolded first.
 */
function parseHeader(raw, name) {
  const end = raw.search(/\r?\n\r?\n/);
  const headerSection = end === -1 ? raw : raw.slice(0, end);
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, " ");
  const m = unfolded.match(new RegExp(`^${name}:[ \\t]*(.+)`, "im"));
  return m ? m[1].trim() : "";
}

/** Strip angle brackets from a single Message-ID token: <id@host> → id@host */
function stripAngleBrackets(s) {
  return s.trim().replace(/^<|>$/g, "").trim();
}

/** Extract every <id> token from a References / In-Reply-To value, without brackets. */
function parseReferences(headerValue) {
  return (headerValue.match(/<[^>]+>/g) || []).map(stripAngleBrackets);
}

/**
 * Normalize a subject for thread matching: strips any number of leading reply/forward
 * prefixes (English and common European forms) and [list-name] tags.
 *
 *   "Re: WG: [All-ipp-intern] Call for Participants" → "Call for Participants"
 */
function normalizeSubject(subject) {
  return subject
    .trim()
    .replace(/^((Re|WG|AW|Fwd?|FW|Sv|Vs|Ref):\s*|\[[^\]]*\]\s*)*/gi, "")
    .trim();
}

/**
 * Message-IDs (without brackets) that identify a message's upstream thread:
 * its own Message-ID plus everything in References and In-Reply-To.
 */
function buildThreadIds(raw) {
  const refs = parseReferences(parseHeader(raw, "References"));
  const inReplyTo = parseReferences(parseHeader(raw, "In-Reply-To"));
  const msgHdrId = stripAngleBrackets(parseHeader(raw, "Message-ID"));
  return new Set([...refs, ...inReplyTo, msgHdrId].filter(Boolean));
}
