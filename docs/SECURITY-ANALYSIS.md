# Security analysis

Status: pre-release review for 0.1.0, updated for the field-test changes in 0.2.0 (September 2026). Method: threat modelling, an independent
code audit with proof-of-concept testing (hostile inputs, SQL sandbox escapes, resource
exhaustion), a second independent review of every component rewritten in response, and
regression tests for every confirmed finding (`test/unit/*`, `test/integration/*`).

## 1. System and assets

donner reads the user's mail through thunderbird-cli's local bridge and stores a searchable copy
(subjects, participants, bodies, attachment text) in `index.sqlite`. It is used by the user and by AI
agents through the CLI and an MCP server.

| Asset | Why it matters |
|---|---|
| Mail content in the index | as sensitive as the mailbox itself |
| Integrity of what agents read | agents act on it (drafts, moves, deletions via thunderbird-cli) |
| Availability of sync / MCP | a hung indexer means stale answers |
| Bridge token | lets any holder control Thunderbird through thunderbird-cli |

## 2. Attackers and entry points

1. **Anyone who can send the user an email** (the main attacker): controls headers, bodies, HTML/CSS,
   attachments, file names, Message-IDs and — partially — authentication headers.
2. **A manipulated agent**: an agent that read a malicious mail may call donner's tools with hostile
   arguments (SQL, huge limits, many parallel calls).
3. **Web pages in the user's browser**: can only reach loopback HTTP services; donner runs none.
4. **Other local users**: must not read the index.

Out of scope: an attacker running code as the user (they can read the Thunderbird profile directly),
bugs inside Thunderbird or thunderbird-cli, and decisions agents make with correct data.

## 3. Findings and fixes

Severity after CVSS-like judgement for a local, single-user tool. All items below are fixed in 0.1.0
unless marked otherwise.

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | **Exponential ReDoS** in HTML table tidying (`(?:\s*\|\s*)+$`): a ~100-byte HTML mail froze `sync`, `watch` and the MCP server's auto-sync permanently (retried every run) | High | Fixed: hand-written linear tokenizer and table tidying; time-bounded regression tests |
| S2 | Quadratic regexes on mail content (unclosed tags `<a<a<a…`: 91 s for 400 KB; style, subject, address and blank-line patterns) | Medium | Fixed: linear parsing, bounded inputs, per-line checks; regression tests |
| S3 | No isolation of the parser: any future parser bug could hang or crash the indexer | Medium | Fixed: every message is parsed in a worker thread with a hard deadline (60 s) and memory cap (512 MB); failures mark the message `error` and sync continues |
| S4 | SQL child could exhaust host memory (`randomblob(5e8)` ×3 → 3 GB RSS); many parallel MCP calls multiply it | Medium | Fixed: POSIX address-space limit on the SQL process (1.5 GB, `DONNER_SQL_MEMORY_MB`), capped `randomblob`/`zeroblob`, one query at a time, 15 s timeout |
| S5 | Keyword filter desynchronisation via SQLite's `$name(...)` parameter syntax hid forbidden words; the static check is the only guard against `ATTACH` (read other SQLite files) | Low (defence in depth) | Fixed: all parameter forms rejected; single statement; first keyword must be SELECT/WITH/VALUES/EXPLAIN; read-only connection + `query_only` |
| S6 | Invisible-character gaps: variation selectors (U+FE00–FE0F, U+E0100–E01EF), Hangul fillers, U+206A–206F, interlinear annotation; Message-ID/List-Id/addresses unsanitised | Medium | Fixed: extended character class, smuggling flagged as hidden content, all header-derived strings sanitised and length-capped |
| S7 | Hidden-content detection bypasses: `<div/style=…>`, `<div/>` treated as self-closing, CSS class/id rules, white/transparent text, `font:0/0`, `transform:scale(0)`, off-screen positioning, `display:/**/none`, `display&colon;none` | Medium | Fixed: attribute parsing per HTML tokenizer rules, `<style>` rules collected, colour/background tracking, CSS comment and entity decoding; 15 bypass cases tested. Detection remains best-effort (see §5) |
| S8 | Message-ID collisions (sender-controlled): content of one message could be reused for another copy; `resolve` could hand out a different message's Thunderbird id | Medium | Fixed: content reuse only within the same account with same size and sender; `resolve` accepts only an exact folder match or a single candidate with same sender and size, never junk, and reports ambiguity |
| S9 | `Authentication-Results` trusted too loosely (first `dmarc=` anywhere, including comments; sender-written headers when the receiver adds none) | Medium | Fixed: RFC 8601 clause parsing with comments stripped; only the topmost header *with a `Received` header below it* (i.e. added in transit) is used |
| S10 | `pdftotext` (native parser) ran on every PDF attachment without limits | Low | Fixed: runs with a 1 GB address-space limit, 30 s timeout, 500-page cap, output cap and a private temp dir; can be switched off (`index.pdftotext: false`). The field test showed the built-in extractor misses text in ~70 % of real-world PDFs, so pdftotext is used by default when installed (accepted risk: poppler parses untrusted PDFs, as every mail client's preview does). Built-in extractor bounded (CMap entry cap, linear section search, O(n) array handling, LZW/inflate output budgets) |
| S11 | `isLoopbackHost` accepted `127.0.0.1.attacker.tld` (egress guard for embeddings) | Low | Fixed: exact IP literal check |
| S12 | Service files: unquoted paths, unescaped XML | Info | Fixed: systemd quoting (incl. `%`), XML escaping, files written 0600 |
| S13 | Sync could wait up to the bridge timeout (120 s per request) after Thunderbird closed | Info (availability) | Fixed: watchdog cancels all in-flight requests when the bridge reports the extension gone |

### Second review (of the rewritten components)

| # | Finding | Severity | Status |
|---|---|---|---|
| R1 | `<style>` inside `<head>` (the normal place) was skipped before its rules were read, so CSS-class hiding was not detected in practice | High | Fixed: all `<style>` blocks are collected in a pre-pass |
| R2 | Tokenizer/browser disagreements exposed hidden text: `</ x>` bogus comments, `</style.x>`, `</span.x>`, markup inside `<textarea>`/`<xmp>` while skipping | High | Fixed: HTML tag-name rules, raw-text elements consumed to their real end tag, bogus comments |
| R3 | White-text gaps: `bgcolor="#fff"` counted as dark, `<font color>`, stale background after deep nesting, CSS escapes (`\6e one`), type selectors, closed `<dialog>`/`<details>`, `%` alpha, `calc()` | Medium | Fixed, each with a test |
| R4 | False positives (visible text dropped or flagged): `@media (max-width…)` rules, background set via class, implicit `</p>`, `<!-->`, `--!>`, `<button>`, Outlook conditional comments counted as hidden | Medium | Fixed: conditional at-rules ignored, background classes tracked, HTML comment and `<p>` rules, only long natural-language comments count as hidden |
| R5 | Parse pool `close()` with waiting parses → uncaught exception later | Medium | Fixed |
| R6 | EPIPE on the SQL child's stdin could crash the host process (incl. MCP server) | Medium | Fixed |
| R7 | `is:constructor` / `has:__proto__` reached prototype properties → crashes | Medium | Fixed: own-property lookups |
| R8 | Semantic/hybrid search changed query meaning (`(a OR b)` became AND, `-(x y)` dropped) | Medium | Fixed: split via the AST |
| R9 | Terms without searchable characters (`-"!"`, `.`) became "match all"/"match nothing" | Low | Fixed: pruned from the AST |
| R10 | Very long or deeply nested queries leaked SQLite/stack errors | Low | Fixed: 200 terms, depth 20, 20 000 characters |
| R11 | `Authentication-Results` clauses split inside quoted strings (`"x;dmarc=pass"@evil`) | Medium | Fixed: quote-aware split; optional authserv-id pinning (`index.trustedAuthservIds`) |
| R12 | Quoted identifiers (`"load_extension"(…)`) passed the function blocklist | Low | Fixed |
| R13 | Formatting: entity-encoded control characters could fake quote markers, literal pipes rewritten, nested list indentation lost, output amplification via deep blockquotes, costly nested anchors, `&#X41;` | Low | Fixed |

### Changes after the field test (0.2.0)

Each change was reviewed for new attack surface; regression tests cover the adversarial cases.

| # | Change | Security consideration | Result |
|---|---|---|---|
| F1 | CSS inheritance: `font-size:0`, colour and `visibility` no longer remove subtrees | Could hidden text reappear? Text is still dropped when its *effective* style (inherited or reset) makes it invisible; `display:none`, opacity, clipping, zero-size overflow and off-screen still remove subtrees | All 15 earlier bypass tests plus new inheritance/reset tests pass |
| F2 | pdftotext used by default when installed | Native parser on untrusted PDFs | Sandboxed: 1 GB address-space limit, 30 s, 500 pages, output cap, private temp file; `index.pdftotext: false` disables. Accepted residual risk (see S10) |
| F3 | Built-in PDF decoders (ASCII85, ASCIIHex, LZW, object streams) | Decompression bombs, malformed data | Shared 64 MB output budget, LZW output bound, dictionary capped at 4096 entries; runs inside the parse worker (deadline, memory cap) |
| F4 | Identities from sent folders | Could a sender make their address "mine" (and thus trusted/known)? Only messages in folders of type *sent* count, with a minimum count; senders cannot place mail there. `notMyAddresses` corrects mistakes | Low |
| F5 | Forged own address | Spam with the user's address as sender used to be "from me" | Messages whose authentication fails are excluded from `from:me` and direction; they stay `is:suspicious` |
| F6 | Authentication-Results: several headers merged | Could a sender add results? Only headers above the receiving server's first `Received` with the same authserv-id are read; sender-written headers are always below a `Received` header | No change in trust boundary |
| F7 | DMARC-based verdict; hidden text flagged only for unauthenticated non-contacts | An attacker with their own DMARC-passing domain can hide text without a `warning`. The hidden text is still removed before indexing and display (agents never see it) and `is:hidden` still finds the message | Accepted: the flag is a triage signal; removal is the defence |
| F8 | `donner_de()` SQL function in FTS triggers | New code in the write path; not registered in the SQL sandbox, so user SQL cannot call it | Deterministic, pure string mapping |
| F9 | Attachments of large messages fetched individually | Resource use | ≤ 10 per message, each ≤ 2 MB (`largeMessageAttachmentBytes`), total ≤ 10 MB; extraction in the worker pool |
| F10 | 8-bit header re-encoding, lenient encoded words, ICS rewrite | Algorithmic complexity | Header scan bounded to 256 KB and linear; lenient decoding skipped above 4,000 characters; ICS parser linear with caps (50 events, 100 attendees, field lengths); adversarial inputs < 0.2 s |

### Second field test (0.3.0)

| # | Change | Security consideration | Result |
|---|---|---|---|
| G1 | Authentication-Results merged down to the provider's entry hop | The sender controls every header below the entry hop and the HELO name inside it. Internal hops are recognised only when the reverse-DNS name (written by the receiving server) belongs to the provider's domain; unrecognised Received lines end the trusted block; the topmost result per method wins | Regression test: a HELO inside the provider's domain does not extend the block |
| G2 | SPF softfail without DMARC is no longer a failure | Fewer spoofed mails flagged when the sender's domain has no DMARC and a soft SPF policy | Accepted: softfail is routine for forwarded and old mail; hard fail and broken DKIM still count; `auth` details stay visible in `trust` |
| G3 | Own-address suggestions | Could a sender become "me"? Suggestions are never applied automatically; they require the same full name as an identity, a minimum count, and no authentication failures | Info |
| G4 | Calendar versions (SEQUENCE) | A sender can send a higher SEQUENCE for someone else's event UID and "cancel" or move it in donner's view | Accepted: the same holds in any calendar client; the original mails stay searchable and are marked `outdated`/`cancelled`, not removed |
| G5 | `<head>` no longer dropped as a whole | Could hidden text reappear? Browsers render stray text after `<head>` too; `title`, `style` and `script` are still dropped, `<style>` rules still apply | Covered by existing hidden-content tests |
| G6 | `donner setup` edits Claude Desktop's config and calls `claude mcp add` | Must not break or leak the user's settings | Only the `mcpServers.donner` key changes, other keys are kept, the previous file is saved as `.bak`, unparsable files are left alone; absolute paths are used; only DONNER_*/TB_* host/port/path variables are passed, never tokens; `claude` is run without a shell (argument array) |

Checked and fine: index/WAL/SHM/lock/saved attachments are `0600` in a `0700` directory; tokens are
redacted in `config` output and never logged; no shell is used for subprocesses except the fixed
`/bin/sh -c 'ulimit …; exec "$@"'` wrapper whose arguments are passed positionally; SQL built from
user queries is fully parameterised and FTS5 terms are always quoted; terminal output strips control
characters from mail-derived text; MCP arguments are validated (types, enums, bounds, unknown keys);
zip extraction is bounded (entries, per-entry and total size); one runtime dependency without
install scripts.

## 4. Prompt injection

Email is an open channel; text written *for the agent* is expected. donner's position:

- **Reduce hidden channels.** Text a human does not see in Thunderbird (hidden HTML, comments,
  invisible Unicode, a text/plain alternative that differs from the displayed HTML) is removed before
  indexing, and its presence is recorded (`is:hidden`, `trust.hidden_content_removed`).
- **Provide signals, not verdicts.** `warning` in search results, `trust` (SPF/DKIM/DMARC from the
  receiving server, `known_contact`) in `show`, `is:suspicious` / `is:authfail` for triage.
- **Mark untrusted content.** Every tool that returns mail text carries a notice that the content is
  third-party data; the MCP server instructions and the skill repeat the rule never to follow
  instructions from mail and to confirm actions with the user.
- **Least privilege.** donner cannot send, delete or move mail. Actions require a second tool
  (thunderbird-cli) and a verified id (`resolve`).

Visible injections ("Ignore previous instructions…" in plain sight) cannot be filtered without
destroying legitimate content; they remain the agent's and user's responsibility.

## 5. Residual risks and recommendations

- **HTML/CSS is a large language.** Hidden-text detection covers the common and the reviewed
  techniques but is not a renderer. Possible remaining gaps: external stylesheets (not loaded by
  Thunderbird either), complex selectors, colour contrast other than white-on-white, `<font color>`.
  Treat `hidden_content_removed: false` as "nothing found", not as "clean".
- **Authentication results** depend on the receiving server writing `Authentication-Results`. If it
  does not, donner reports none (never a forged pass).
- **SQL memory limit on Windows**: the address-space limit uses `ulimit` and is not available on
  Windows; capped functions, the timeout and serialisation still apply.
- **Index at rest** is not encrypted by donner. Use full-disk encryption; `donner reset --yes` removes it.
- **Upstream**: tb-bridge does not fail pending requests when the extension disconnects (donner works
  around it) and runs without authentication by default; setting `TB_AUTH_TOKEN` is recommended.

## 6. How to re-run the checks

```bash
npm test                                   # includes ReDoS, bypass, sandbox and collision tests
node bin/donner.js sql "SELECT randomblob(500000000)"          # → error, bounded
node bin/donner.js sql "SELECT \$a('), fts3_tokenizer('x'), \$b(')"   # → SQL_REJECTED
```
