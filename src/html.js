// HTML → plain text for indexing and display.
//
// Besides readability, this is a security boundary: content a human cannot see in
// Thunderbird (display:none blocks, zero-size or invisible text, off-screen boxes, CSS-class
// hiding, long comments, scripts) is removed so an agent does not read instructions that
// were hidden from the user. `hiddenRemoved` reports when that happened. Detection is
// best-effort; it errs on the side of removing text that renders invisibly.
//
// Everything here runs on attacker-controlled input, so the tokenizer is a hand-written
// single pass (linear time), follows the HTML tokenizer rules where they matter for
// visibility (raw-text elements, bogus comments, tag names), and no regular expression with
// nested quantifiers touches the raw HTML.

import { decodeEntities } from "./entities.js";

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
  "source", "track", "wbr", "basefont", "frame", "keygen",
]);
// Elements whose content is never rendered as text.
const DROP = new Set(["script", "style", "title", "template", "svg", "math", "object", "iframe", "select", "noembed", "noframes", "canvas", "audio", "video"]);
// Raw-text elements: their content is not markup; it ends only at the matching close tag.
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "header", "hgroup", "main", "nav", "ol", "p",
  "pre", "section", "summary", "table", "tbody", "thead", "tfoot", "ul", "caption", "body", "html",
]);
// Start tags that implicitly close an open <p>.
const P_CLOSERS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);
const MAX_INPUT = 4 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_STACK = 512;
const CELL = "\u0003"; // table cell separator, turned into " | " at the end

// ─── CSS ────────────────────────────────────────────────────────────

function stripCssComments(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf("/*", i);
    if (start < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start) + " ";
    const end = s.indexOf("*/", start + 2);
    i = end < 0 ? s.length : end + 2;
  }
  return out;
}

/** CSS escapes: "\6e one" → "none", "\:" → ":" */
function cssUnescape(s) {
  if (!s.includes("\\")) return s;
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n])/g, (m, hex, ch) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return ch;
  });
}

/** "a:b; c:d" → Map(prop → value), lowercased, !important removed. */
export function parseDeclarations(style) {
  const decls = new Map();
  for (const part of cssUnescape(stripCssComments(String(style).slice(0, 64 * 1024))).split(";")) {
    const c = part.indexOf(":");
    if (c < 0) continue;
    const prop = part.slice(0, c).trim().toLowerCase();
    const value = part.slice(c + 1).replace(/!\s*important/i, "").trim().toLowerCase();
    if (prop && prop.length < 64) decls.set(prop, value.slice(0, 256));
    if (decls.size > 200) break;
  }
  return decls;
}

function cssLength(v) {
  // → value in px (approximate), or null
  let s = String(v || "").trim();
  const calc = s.match(/^(?:calc|min|max|clamp)\(\s*([^(),]*?)\s*(?:,[^()]*)?\)$/);
  if (calc) s = calc[1];
  const m = s.match(/^(-?\d*\.?\d+)\s*(px|pt|em|rem|%|vh|vw|cm|mm|in|ex|ch)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] || "px";
  return n * ({ px: 1, pt: 1.33, em: 16, rem: 16, "%": 0.16, vh: 8, vw: 8, cm: 38, mm: 3.8, in: 96, ex: 8, ch: 8 }[unit] ?? 1);
}

const WHITE = new Set(["#fff", "#ffffff", "white", "rgb(255,255,255)", "#fffffe", "snow", "#fefefe", "#fdfdfd", "ghostwhite", "rgba(255,255,255,1)"]);

function colorKey(v) {
  return String(v || "").replace(/\s+/g, "").toLowerCase();
}

function alphaValue(a) {
  if (a === undefined) return 1;
  return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
}

function transparentColor(v) {
  const c = colorKey(v);
  if (c === "transparent") return true;
  const m = c.match(/^(?:rgba|hsla)\([^)]*,([\d.]+%?)\)$/) || c.match(/^(?:rgb|hsl)a?\([^)/]*\/([\d.]+%?)\)$/);
  if (m) return alphaValue(m[1]) < 0.05;
  return /^#[0-9a-f]{6}0[0-9a-f]$/.test(c) || /^#[0-9a-f]{3}0$/.test(c);
}

function isWhite(v) {
  return WHITE.has(colorKey(v));
}

function hasBackground(decls, attrs) {
  const bgAttr = attrs?.get("bgcolor");
  if (bgAttr && !isWhite(bgAttr) && !transparentColor(bgAttr)) return true;
  if (attrs?.has("background")) return true;
  for (const p of ["background", "background-color", "background-image"]) {
    const v = decls.get(p);
    if (v && v !== "none" && v !== "transparent" && v !== "inherit" && v !== "initial" && !isWhite(v)) return true;
  }
  return false;
}

const RELEVANT = new Set([
  "display", "visibility", "opacity", "font-size", "font", "overflow", "overflow-x", "overflow-y", "height", "max-height",
  "width", "max-width", "clip", "clip-path", "text-indent", "left", "top", "right", "margin-left", "margin-top", "position",
  "transform", "color", "background", "background-color", "background-image",
]);

/**
 * Properties that remove an element *and everything inside it* from view. Children cannot
 * undo them (display:none, opacity:0, a clipped 0×0 box, off-screen positioning, scale(0)).
 */
export function hardHidden(d) {
  const get = (p) => d.get(p) || "";
  if (get("display") === "none") return true;
  if (d.has("opacity") && parseFloat(get("opacity")) < 0.05) return true;
  const overflowHidden = /hidden|clip/.test(get("overflow") + " " + get("overflow-x") + " " + get("overflow-y"));
  const h = cssLength(get("height"));
  const mh = cssLength(get("max-height"));
  const w = cssLength(get("width"));
  const mw = cssLength(get("max-width"));
  if (overflowHidden && ((h !== null && h <= 1) || (mh !== null && mh <= 1) || (w !== null && w <= 1) || (mw !== null && mw <= 1))) return true;
  if (/rect\(\s*0/.test(get("clip")) || /inset\(\s*50%|circle\(\s*0/.test(get("clip-path"))) return true;
  const ti = cssLength(get("text-indent"));
  if (ti !== null && ti <= -500) return true;
  for (const p of ["left", "top", "margin-left", "margin-top", "right"]) {
    const v = cssLength(get(p));
    if (v !== null && v <= -500 && (p.startsWith("margin") || /absolute|fixed|relative/.test(get("position")))) return true;
  }
  if (/scale\(\s*0(?:\.0+)?\s*[,)]|scale[xy]?\(\s*0(?:\.0+)?\s*\)/.test(get("transform"))) return true;
  return false;
}

/** Font size from font-size or the font shorthand: true = invisibly small, false = readable, null = not set. */
function tinyFont(d) {
  if (d.has("font-size")) {
    const fs = cssLength(d.get("font-size"));
    return fs !== null && fs <= 2;
  }
  const font = d.get("font");
  if (font) return /(?:^|\s)0(?:px|pt|em|rem|%)?(?:\/|\s|$)/.test(font);
  return null;
}

const EMPTY_ATTRS = new Map();
const ROOT_STATE = Object.freeze({ name: "#root", bg: false, bgColor: null, color: null, tinyFont: false, invisible: false });

/**
 * Computed, inherited text visibility of an element. font-size, color and visibility are
 * inherited and can be reset by children (MJML/newsletter layouts set font-size:0 on table
 * cells and restore it inside), so they must not remove the whole subtree.
 */
function childState(parent, name, d, attrs, ownBgExtra) {
  const ownBg = hasBackground(d, attrs) || ownBgExtra;
  const bgValue = d.get("background-color") || d.get("background") || attrs?.get("bgcolor") || null;
  const tf = tinyFont(d);
  const vis = d.get("visibility");
  return {
    name,
    bg: parent.bg || ownBg,
    bgColor: bgValue ? colorKey(bgValue) : parent.bgColor,
    color: d.has("color") ? colorKey(d.get("color")) : parent.color,
    tinyFont: tf === null ? parent.tinyFont : tf,
    invisible: vis ? vis === "hidden" || vis === "collapse" : parent.invisible,
  };
}

function textInvisible(st) {
  if (st.tinyFont || st.invisible) return true;
  if (st.color) {
    if (transparentColor(st.color)) return true;
    if (st.bgColor && st.color === st.bgColor) return true;
    if (isWhite(st.color) && !st.bg) return true;
  }
  return false;
}

/** Back-compat helper: would text directly inside an element with these declarations be invisible? */
export function hiddenByCss(d, darkBackground = false) {
  if (hardHidden(d)) return true;
  return textInvisible(childState({ ...ROOT_STATE, bg: darkBackground }, "x", d, null, false));
}

/**
 * Collect rules from all <style> blocks as declarations per class, id and tag (simple selectors
 * only). Rules inside @media width/print conditions and other at-rules are conditional
 * (e.g. mobile layouts) and ignored.
 */
function collectStyleRules(html, lower) {
  const rules = { classes: new Map(), ids: new Map(), tags: new Map() };
  let i = 0;
  let budget = 512 * 1024;
  while (budget > 0) {
    const open = lower.indexOf("<style", i);
    if (open < 0) break;
    const gt = lower.indexOf(">", open);
    if (gt < 0) break;
    const close = lower.indexOf("</style", gt);
    const css = html.slice(gt + 1, close < 0 ? html.length : Math.min(close, gt + 1 + budget));
    budget -= css.length;
    parseCssRules(css, rules);
    if (close < 0) break;
    i = close + 7;
  }
  return rules;
}

function parseCssRules(cssText, rules) {
  const css = cssUnescape(stripCssComments(cssText));
  let depth = 0;
  let conditional = 0; // depth at which a conditional group started (0 = none)
  let start = 0;
  let selector = null;
  for (let k = 0; k < css.length; k++) {
    const c = css[k];
    if (c === "{") {
      const head = css.slice(start, k).trim();
      depth++;
      if (head.startsWith("@")) {
        // "@media screen { … }" applies in a mail client; width/print conditions do not.
        const always = /^@media\s+(?:only\s+)?(?:all|screen)(?:\s*,\s*(?:all|screen))*$/i.test(head) || /^@media\s*$/i.test(head);
        if (!always && !conditional) conditional = depth;
        selector = null;
      } else selector = head;
      start = k + 1;
    } else if (c === "}") {
      if (selector !== null && !conditional) applyRule(selector, parseDeclarations(css.slice(start, k)), rules);
      selector = null;
      if (conditional && depth === conditional) conditional = 0;
      depth = Math.max(0, depth - 1);
      start = k + 1;
    }
  }
}

function mergeInto(map, key, decls) {
  if (map.size > 5000 && !map.has(key)) return;
  const cur = map.get(key) || new Map();
  for (const [p, v] of decls) cur.set(p, v);
  map.set(key, cur);
}

function applyRule(selectorList, decls, rules) {
  const relevant = new Map([...decls].filter(([p]) => RELEVANT.has(p)));
  if (!relevant.size) return;
  for (const sel of selectorList.split(",")) {
    const trimmed = sel.trim();
    const last = trimmed.split(/[\s>+~]+/).pop() || "";
    if (/[:[*]/.test(last)) continue; // pseudo-classes/attribute/universal selectors: too conditional
    // Tag rules only for plain "span { … }" selectors, never "div span" (too broad).
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(trimmed) && !["html", "body"].includes(trimmed.toLowerCase())) mergeInto(rules.tags, trimmed.toLowerCase(), relevant);
    for (const m of last.matchAll(/([.#])([A-Za-z0-9_-]{1,100})/g)) {
      mergeInto(m[1] === "." ? rules.classes : rules.ids, m[2].toLowerCase(), relevant);
    }
  }
}

/** Effective declarations: tag rules < class rules < id rules < inline style. */
function effectiveDecls(name, attrs, rules) {
  const d = new Map();
  const add = (m) => m && m.forEach((v, p) => d.set(p, v));
  add(rules.tags.get(name));
  for (const c of (attrs.get("class") || "").toLowerCase().split(/\s+/)) if (c) add(rules.classes.get(c));
  const id = (attrs.get("id") || "").toLowerCase();
  if (id) add(rules.ids.get(id));
  if (attrs.has("style")) add(parseDeclarations(attrs.get("style")));
  if (name === "font" && attrs.has("color") && !d.has("color")) d.set("color", attrs.get("color").toLowerCase());
  return d;
}

// ─── Tokenizer ──────────────────────────────────────────────────────

/** Parse attributes of a start tag body (text between the tag name and ">"). */
function parseAttrs(s) {
  const attrs = new Map();
  let i = 0;
  while (i < s.length && attrs.size < 64) {
    while (i < s.length && (s[i] === "/" || /\s/.test(s[i]))) i++;
    const start = i;
    while (i < s.length && !/[\s/>=]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    while (i < s.length && /\s/.test(s[i])) i++;
    let value = "";
    if (s[i] === "=") {
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, i + 1);
        value = s.slice(i + 1, end < 0 ? s.length : end);
        i = end < 0 ? s.length : end + 1;
      } else {
        const vs = i;
        while (i < s.length && !/[\s>]/.test(s[i])) i++;
        value = s.slice(vs, i);
      }
    }
    if (!name) {
      if (i === start) i++;
      continue;
    }
    if (!attrs.has(name)) attrs.set(name, decodeEntities(value));
  }
  return attrs;
}

/** Find the ">" that ends a tag starting at `from`, honouring quoted attribute values. */
function tagEnd(html, from) {
  let q = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      // Quotes only matter inside an attribute value (after "=").
      let k = i - 1;
      while (k > from && /\s/.test(html[k])) k--;
      if (html[k] === "=") q = c;
    } else if (c === ">") return i;
  }
  return -1;
}

/** Index after the close tag of a raw-text element, e.g. "</style>" (name followed by space, / or >). */
function rawTextEnd(lower, from, name) {
  let i = from;
  const needle = "</" + name;
  for (;;) {
    const k = lower.indexOf(needle, i);
    if (k < 0) return { contentEnd: lower.length, next: lower.length };
    const after = lower[k + needle.length];
    if (after === undefined || after === ">" || after === "/" || /\s/.test(after)) {
      const gt = lower.indexOf(">", k);
      return { contentEnd: k, next: gt < 0 ? lower.length : gt + 1 };
    }
    i = k + needle.length;
  }
}

/** Comment starting at i ("<!--"): index after its end, per the HTML tokenizer. */
function commentEnd(html, i) {
  const s = i + 4;
  if (html[s] === ">") return s + 1; // "<!-->"
  if (html[s] === "-" && html[s + 1] === ">") return s + 2; // "<!--->"
  const a = html.indexOf("-->", s);
  const b = html.indexOf("--!>", s);
  if (a < 0 && b < 0) return html.length;
  if (a < 0) return b + 4;
  if (b < 0) return a + 3;
  return Math.min(a + 3, b + 4);
}

/** Is there any non-space text outside tags? (linear scan) */
function hasVisibleText(s) {
  let inTag = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inTag) {
      if (c === ">") inTag = false;
    } else if (c === "<") inTag = true;
    else if (!/\s/.test(c)) return true;
  }
  return false;
}

function shortenUrl(href) {
  if (!href) return null;
  const h = href.trim();
  if (/^(?:mailto:|tel:)/i.test(h)) return null;
  if (!/^https?:\/\//i.test(h)) return null;
  if (h.length <= 100) return h;
  try {
    const u = new URL(h);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return h.slice(0, 100) + "…";
  }
}

/**
 * Convert HTML to readable text.
 * @param {string} html
 * @param {{links?: boolean, depth?: number}} [opts]
 * @returns {{text: string, hiddenRemoved: boolean}}
 */
export function htmlToText(html, { links = true, depth = 0 } = {}) {
  if (!html) return { text: "", hiddenRemoved: false };
  if (html.length > MAX_INPUT) html = html.slice(0, MAX_INPUT);
  const lower = html.toLowerCase();
  const rules = collectStyleRules(html, lower);
  let hiddenRemoved = false;
  const out = [];
  let outLen = 0;
  const stack = []; // {name, bg}
  const openCount = new Map();
  let skipName = null;
  let skipDepth = 0;
  const linkStack = [];
  let listDepth = 0;
  let inPre = 0;
  const push = (s) => {
    if (outLen > MAX_OUTPUT) return;
    out.push(s);
    outLen += s.length;
  };
  const newline = (n = 1) => push(n === 2 ? "\n\n" : "\n");
  const text = (s) => {
    if (skipName) return;
    if (stack.length && textInvisible(stack[stack.length - 1])) {
      // Inherited invisibility (tiny font, invisible colour, visibility:hidden) hides the text
      // itself; children may reset it, so only this text node is dropped.
      if (/[\p{L}\p{N}]/u.test(s)) hiddenRemoved = true;
      return;
    }
    // Decoded text must not contain our internal markers (\u0001-\u0003).
    const t = decodeEntities(s).replace(/[\u0001-\u0003]/g, "");
    push(inPre ? t : t.replace(/[ \t\r\n\f]+/g, " "));
  };
  const popTo = (name) => {
    if (!openCount.get(name)) return;
    while (stack.length) {
      const e = stack.pop();
      openCount.set(e.name, openCount.get(e.name) - 1);
      if (e.name === name) break;
    }
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    const next = html[i + 1];
    if (html.startsWith("<!--", i)) {
      const end = commentEnd(html, i);
      const body = html.slice(i + 4, end);
      // Comments are invisible. Long natural-language comments are a classic place to hide
      // instructions for agents; short template comments and Outlook conditionals are not.
      if (!skipName && !/^\s*\[(?:if|endif)/i.test(body) && (body.match(/[\p{L}]{2,}/gu)?.length || 0) >= 8) hiddenRemoved = true;
      i = end;
      continue;
    }
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", i + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = next === "/";
    const nameStart = closing ? i + 2 : i + 1;
    if (!/[a-zA-Z]/.test(html[nameStart] || "")) {
      if (closing) {
        // "</ foo>" is a bogus comment in HTML: invisible.
        const end = html.indexOf(">", i + 2);
        i = end < 0 ? html.length : end + 1;
        continue;
      }
      text("<");
      i++;
      continue;
    }
    let ne = nameStart;
    while (ne < html.length && !/[\s/>]/.test(html[ne])) ne++;
    const name = lower.slice(nameStart, ne);
    const end = tagEnd(html, ne);
    if (end < 0) break; // unterminated tag at EOF: dropped, like browsers do
    const attrSrc = html.slice(ne, end);
    i = end + 1;

    // Raw-text elements: jump to their end, whatever state we are in.
    if (!closing && RAW_TEXT.has(name)) {
      const r = rawTextEnd(lower, i, name);
      const content = html.slice(i, r.contentEnd);
      i = r.next;
      if (!skipName && (name === "textarea" || name === "xmp" || name === "plaintext")) {
        // Visible as-is in the rendered mail.
        push("\n");
        push(decodeEntities(content).replace(/[\u0001-\u0003]/g, ""));
        push("\n");
      }
      continue;
    }

    // Inside a dropped/hidden element: only track nesting of the same element name.
    if (skipName) {
      if (name === skipName) {
        if (closing) {
          if (--skipDepth === 0) skipName = null;
        } else if (!VOID.has(name)) skipDepth++;
        continue;
      }
      // A block start tag implicitly closes a hidden <p>; what follows is visible again.
      if (skipName === "p" && skipDepth === 1 && !closing && P_CLOSERS.has(name)) {
        skipName = null;
      } else continue;
    }

    if (!closing) {
      if (DROP.has(name)) {
        skipName = name;
        skipDepth = 1;
        continue;
      }
      const parent = stack.length ? stack[stack.length - 1] : ROOT_STATE;
      let attrs;
      let isHidden;
      let state;
      if (!/\S/.test(attrSrc) && !rules.tags.has(name) && name !== "dialog") {
        // Fast path: a bare tag inherits everything (most <br>, <p>, <td> in real mail).
        attrs = EMPTY_ATTRS;
        isHidden = false;
        state = parent.name === name ? parent : { ...parent, name };
      } else {
        attrs = parseAttrs(attrSrc);
        const decls = effectiveDecls(name, attrs, rules);
        isHidden = attrs.has("hidden") || (name === "dialog" && !attrs.has("open")) || hardHidden(decls);
        state = childState(parent, name, decls, attrs, false);
      }
      if (name === "details" && !attrs.has("open") && !isHidden && depth < 2) {
        // Closed <details>: only the <summary> is visible.
        const r = rawTextEnd(lower, i, "details");
        const inner = html.slice(i, r.contentEnd);
        const innerLower = inner.toLowerCase();
        const s1 = innerLower.indexOf("<summary");
        if (s1 >= 0) {
          const s2 = rawTextEnd(innerLower, s1, "summary");
          const summary = htmlToText(inner.slice(s1, s2.contentEnd), { links, depth: depth + 1 });
          push("\n" + summary.text + "\n");
        }
        const rest = s1 >= 0 ? inner.slice(0, s1) + inner.slice(rawTextEnd(innerLower, s1, "summary").next) : inner;
        if (hasVisibleText(rest)) hiddenRemoved = true;
        i = r.next;
        continue;
      }
      if (VOID.has(name)) {
        if (isHidden || textInvisible(state)) continue;
      } else {
        if (isHidden) {
          skipName = name;
          skipDepth = 1;
          hiddenRemoved = true;
          continue;
        }
        if (P_CLOSERS.has(name)) popTo("p");
        if (stack.length < MAX_STACK) {
          stack.push(state);
          openCount.set(name, (openCount.get(name) || 0) + 1);
        }
      }
      switch (name) {
        case "br":
          newline();
          break;
        case "hr":
          push("\n---\n");
          break;
        case "blockquote":
          push("\n\u0001\n");
          break;
        case "p":
          newline(2);
          break;
        case "tr":
        case "div":
        case "table":
        case "section":
        case "article":
        case "header":
        case "footer":
          newline();
          break;
        case "td":
        case "th":
          push(CELL);
          break;
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          push("\n\n");
          break;
        case "ul":
        case "ol":
          listDepth++;
          newline();
          break;
        case "li":
          push("\n" + "  ".repeat(Math.max(0, Math.min(listDepth, 6) - 1)) + "- ");
          break;
        case "pre":
          inPre++;
          newline();
          break;
        case "img": {
          const alt = (attrs.get("alt") || "").trim();
          if (alt && alt.length < 200) push(`[${alt.replace(/[\u0001-\u0003]/g, "")}]`);
          break;
        }
        case "a":
          linkStack.push({ href: links ? shortenUrl(attrs.get("href")) : null, start: out.length });
          if (linkStack.length > 64) linkStack.shift();
          break;
        default:
          if (BLOCK.has(name)) newline();
      }
    } else {
      popTo(name);
      switch (name) {
        case "p":
          newline(2);
          break;
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          push("\n");
          break;
        case "ul":
        case "ol":
          listDepth = Math.max(0, listDepth - 1);
          newline();
          break;
        case "pre":
          inPre = Math.max(0, inPre - 1);
          newline();
          break;
        case "a": {
          const l = linkStack.pop();
          if (l?.href) {
            // Only compare short link texts; long ones are never just the URL.
            const inner = out.length - l.start <= 8 ? out.slice(l.start).join("").trim() : "…";
            if (!inner) push(l.href);
            else if (inner !== l.href && !l.href.includes(inner) && !inner.includes(l.href.replace(/…$/, ""))) push(` <${l.href}>`);
          }
          break;
        }
        case "blockquote":
          push("\n\u0002\n");
          break;
        case "tr":
        case "table":
        case "div":
        case "li":
          newline();
          break;
        default:
          if (BLOCK.has(name)) newline();
      }
    }
  }
  const textOut = tidyText(applyQuoteMarkers(out.join(""))).slice(0, MAX_OUTPUT);
  return { text: textOut, hiddenRemoved };
}

// Lines inside <blockquote> get a ">" prefix per nesting level (capped), like plain-text quoting.
function applyQuoteMarkers(s) {
  if (!s.includes("\u0001")) return s.replace(/\u0002/g, "");
  let depth = 0;
  const lines = [];
  const prefix = () => ">".repeat(Math.min(depth, 5)) + " ";
  for (const line of s.split("\n")) {
    if (line.includes("\u0001") || line.includes("\u0002")) {
      for (const ch of line) {
        if (ch === "\u0001") depth = Math.min(depth + 1, 1000);
        else if (ch === "\u0002") depth = Math.max(0, depth - 1);
      }
      const rest = line.replace(/[\u0001\u0002]/g, "");
      if (rest.trim()) lines.push(prefix() + rest.trim());
      continue;
    }
    lines.push(depth > 0 && line.trim() ? prefix() + line.trim() : line);
  }
  return lines.join("\n");
}

/** Table cells: split on the cell marker, drop empty cells, re-join (linear). */
function tidyCells(line) {
  if (!line.includes(CELL)) return line;
  return line
    .split(CELL)
    .map((c) => c.trim())
    .filter(Boolean)
    .join(" | ");
}

/** Collapse whitespace produced by markup: tidy lines and table rows, max one blank line. */
export function tidyText(s) {
  const lines = s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => {
      const indent = /^ +- /.test(line) ? line.match(/^ +/)[0] : "";
      return indent + tidyCells(line.replace(/[ \t]+/g, " ").trim());
    });
  const isTableRow = (l) => l.includes(" | ");
  const isItem = (l) => /^ *- /.test(l);
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line === "") {
      const prev = out.length ? out[out.length - 1] : "";
      if (prev === "") continue; // leading or repeated blank line
      let n = k + 1;
      while (n < lines.length && lines[n] === "") n++;
      const next = n < lines.length ? lines[n] : "";
      // No blank lines inside lists and tables.
      if (isItem(next) && isItem(prev)) continue;
      if (isTableRow(next) && isTableRow(prev)) continue;
      out.push("");
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
