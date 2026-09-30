// Plain-text helpers: sanitising, splitting own text from quoted history, snippets.

// Invisible characters that can smuggle text past a human reader:
// zero-width chars, bidi controls, soft hyphen, word joiners, BOM and the Unicode "tag"
// block (U+E0000–E007F, used for ASCII-smuggling prompt injection).
const INVISIBLE =
  /[\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|\udb40[\udc00-\udc7f\udd00-\uddef]/g;
// Characters whose presence means someone deliberately hid text (not merely typography).
const SUSPICIOUS = /[\u202a-\u202e\u2066-\u2069\u115f\u1160\u3164\uffa0\ufff9-\ufffb]|\udb40[\udc00-\udc7f\udd00-\uddef]/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Remove invisible and control characters.
 * @returns {{text: string, removed: boolean}}
 */
export function sanitizeText(s) {
  if (!s) return { text: "", removed: false };
  const str = String(s);
  let removed = SUSPICIOUS.test(str);
  let count = 0;
  let text = str.replace(INVISIBLE, () => {
    count++;
    return "";
  });
  // Long runs of zero-width characters are a smuggling channel too (e.g. binary encoding).
  if (count >= 16 && count > str.length / 50) removed = true;
  text = text.replace(CONTROL, "").replace(/[\u2028\u2029]/g, "\n");
  return { text, removed };
}

const ATTRIBUTION = [
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  /^\s*Am\b.{0,200}\bschrieb\b.{0,200}:\s*$/i,
  /^\s*Am\b.{0,200}\bhat\b.{0,200}\bgeschrieben:\s*$/i,
  /^\s*Le\b.{0,200}\ba écrit\s*:\s*$/i,
  /^\s*El\b.{0,200}\bescribió:\s*$/i,
  /^\s*Il\b.{0,200}\bha scritto:\s*$/i,
  /^\s*Op\b.{0,200}\bschreef\b.{0,200}:\s*$/i,
  /^\s*-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Originalnachricht|Message d'origine|Mensaje original)\s*-{2,}\s*$/i,
];
// Outlook-style header block: "From: … / Sent: … / To: … / Subject: …" (en/de)
const OUTLOOK_FROM = /^\s*\*?(?:From|Von|De|Van)\s*:\*?\s+\S/i;
const OUTLOOK_NEXT = /^\s*\*?(?:Sent|Gesendet|Date|Datum|Envoyé|To|An|À|Subject|Betreff|Objet|Cc)\s*:\*?/i;
const FORWARD = /^\s*(?:-{2,}\s*(?:Forwarded message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado)\s*-{2,}|Begin forwarded message:|Anfang der weitergeleiteten Nachricht:)\s*$/i;
const SIG = /^-- ?$/;

/**
 * Split a plain-text body into the author's own text and the quoted history/signature.
 * Forwarded content is kept in `own` because it is new information for this mailbox.
 */
export function splitQuoted(text) {
  if (!text) return { own: "", quoted: "" };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const own = [];
  const quoted = [];
  let rest = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (rest) {
      quoted.push(line);
      continue;
    }
    if (line.length > 1000) {
      // Very long lines are never attribution/marker lines; skip regex checks on them.
      own.push(line);
      continue;
    }
    if (FORWARD.test(line)) {
      own.push(line);
      continue;
    }
    if (SIG.test(line) && i > 0) {
      rest = true;
      quoted.push(line);
      continue;
    }
    // "On … wrote:" followed by a ">"-marked quote: only the marked lines are quoted, so text
    // written below the quote (bottom posting) or between quotes (inline replies) stays the
    // author's own. Followed by an unmarked quote (Outlook style): everything after is quoted.
    const twoLine = i + 1 < lines.length && /^\s*(?:On|Am)\b/.test(line) && /^\s*(?:wrote|schrieb)\b.*:\s*$/i.test(lines[i + 1]) && line.length < 200;
    if (twoLine || ATTRIBUTION.some((re) => re.test(line))) {
      const after = twoLine ? i + 2 : i + 1;
      quoted.push(line);
      if (twoLine) quoted.push(lines[++i]);
      if (!markedQuoteFollows(lines, after)) rest = true;
      continue;
    }
    if (OUTLOOK_FROM.test(line)) {
      let hits = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) if (OUTLOOK_NEXT.test(lines[j])) hits++;
      if (hits >= 2) {
        rest = true;
        quoted.push(line);
        continue;
      }
    }
    if (/^\s*>/.test(line)) {
      quoted.push(line);
      continue;
    }
    own.push(line);
  }
  return { own: trimBlank(own.join("\n")), quoted: trimBlank(quoted.join("\n")) };
}

function markedQuoteFollows(lines, from) {
  for (let j = from; j < lines.length && j < from + 5; j++) {
    if (!lines[j].trim()) continue;
    return /^\s*>/.test(lines[j]);
  }
  return false;
}

function trimBlank(s) {
  return s.trim().replace(/\n{3,}/g, "\n\n");
}

export function makeSnippet(text, max = 200) {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

/** "Re: AW: [list] Subject" → "Subject" */
const SUBJECT_PREFIX = /^(?:(?:re|aw|wg|fwd?|fw|sv|vs|ref|antw|tr|rif|r)[ \t]*(?:\[\d{1,4}\])?[ \t]*:|\[[^\]]{1,40}\])[ \t]*/i;

export function normalizeSubject(subject) {
  let s = String(subject || "").slice(0, 1000).trim();
  // Strip prefixes one at a time (bounded loop instead of a repeated group).
  for (let n = 0; n < 20; n++) {
    const m = s.match(SUBJECT_PREFIX);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

export function truncate(text, max) {
  if (!text || !max || text.length <= max) return { text: text || "", truncated: false };
  return { text: text.slice(0, max) + "…", truncated: true };
}

/** Strip angle brackets and whitespace from a Message-ID. */
export function cleanMid(s) {
  return sanitizeText(String(s || "").slice(0, 998)).text.trim().replace(/^<|>$/g, "").replace(/\s+/g, "").trim();
}

/** Every <id> token in a References / In-Reply-To header. */
export function parseMidList(s) {
  if (!s) return [];
  const found = String(s).match(/<[^<>\s]+>/g);
  if (found) return found.map(cleanMid);
  return String(s).split(/\s+/).map(cleanMid).filter((x) => x.includes("@"));
}

/**
 * Parse "Name <addr>" / "addr" strings as delivered by Thunderbird's MessageHeader.
 * @returns {{name: string, addr: string}}
 */
export function parseAddress(s) {
  const str = String(s || "").slice(0, 2000).trim();
  const lt = str.lastIndexOf("<");
  if (lt >= 0 && str.endsWith(">") && str.indexOf(">", lt) === str.length - 1) {
    const name = str.slice(0, lt).trim().replace(/^"|"$/g, "").replace(/\\"/g, '"').trim();
    return { name, addr: str.slice(lt + 1, -1).trim().toLowerCase() };
  }
  if (str.includes("@")) return { name: "", addr: str.toLowerCase() };
  return { name: str, addr: "" };
}

/** Split a header address list that may contain commas inside quoted names. */
export function splitAddressList(s) {
  if (Array.isArray(s)) return s.flatMap(splitAddressList);
  const str = String(s || "");
  const out = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of str) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function formatAddress({ name, addr }) {
  if (name && addr) return `${name} <${addr}>`;
  return addr || name || "";
}

/**
 * Fold a name or address for tolerant matching: lowercase, no diacritics, ß → ss and the
 * German transliterations ae/oe/ue → a/o/u — so "Björn", "Bjoern" and "BJORN" all match.
 * Applied to both the stored value and the query.
 */
const GERMAN = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss", ẞ: "SS" };
const GERMAN_RE = /[äöüÄÖÜßẞ]/g;

/**
 * German transliteration for the full-text index: ä→ae, ö→oe, ü→ue, ß→ss. Applied to indexed
 * text and to query terms, so "müller" and "mueller" find each other while "poet" no longer
 * matches "pot". Keeps the number of tokens unchanged (highlighting stays aligned).
 */
export function germanFold(s) {
  if (s === null || s === undefined) return s;
  s = String(s);
  if (s.includes("\u0308")) s = s.normalize("NFC");
  GERMAN_RE.lastIndex = 0;
  if (!GERMAN_RE.test(s)) return s;
  return s.replace(GERMAN_RE, (c) => GERMAN[c]);
}

/** Tolerant form for name/address matching: lowercase, German transliteration, no accents. */
export function fold(s) {
  return germanFold(String(s || ""))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}
