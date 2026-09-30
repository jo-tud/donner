# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).
The JSON output shape, error codes and MCP tool names are the public API.

## [Unreleased]

### Fixed
- Windows: `donner setup` finds an npm-installed Claude Code (`claude.cmd`); `reset` and
  `uninstall --purge` explain when the index is still open in another program (`INDEX_IN_USE`).
- Tests run on macOS and Windows (platform paths, line endings via `.gitattributes`, open
  handles); CI uses actions/checkout and setup-node v5.
- `DONNER_NO_SERVICE_MANAGER=1` writes/removes service files without calling systemctl/launchctl.

## [0.3.1] — 2026-09-30

### Changed
- Published on npm: install with `npm install -g donner-mail`, update with
  `npm install -g donner-mail@latest`; README, quick start and skill say so.
- Same code as 0.3.0, which was withdrawn from npm (packaging metadata only).

## [0.3.0] — 2026-09-30

Second field test. The index is upgraded automatically (schema 4); the next sync re-reads calendar
mails, incomplete authentication results, empty bodies and replies whose text was filed as quote.

### Added
- `donner setup`: one command for installation and updates — checks Thunderbird/thunderbird-cli
  and pdftotext, registers the MCP server in Claude Desktop (settings kept, `.bak` written) and
  Claude Code (`claude mcp add --scope user`), installs the skill, builds or upgrades the index,
  asks about likely own addresses and installs/restarts the background service. Idempotent.
- `donner uninstall [--purge --yes]`: removes service, Claude registrations and skill (and with
  `--purge` the index and config).
- `donner service stop`; `service install` restarts a running service so updates take effect.

### Fixed
- Calendar: only the newest version of an event counts (SEQUENCE, RECURRENCE-ID); cancellations
  apply; series without an end stop one year after their newest message; `--sort event` and
  the `event` field use the next occurrence. Years-old series no longer bury the real upcoming
  invitations.
- A duplicated or unclosed `<head>` swallowed the whole mail.
- Text written below a `>` quote (bottom posting) or between quotes was filed as quote.
- Authentication-Results: headers are merged down to the hop where the mail entered the
  provider (some providers write them on different internal hops); SPF softfail without DMARC no
  longer counts as failed authentication.
- Threads: a reply chain whose first message references a missing mail joins its conversation.
- `Sent-1`, `sent-mail` and similar folder names are recognised as sent folders; `doctor`
  suggests the exact folder names to exclude instead of a generic pattern.

### Added
- `status`/`mail_status` `possibly_mine` and a `doctor` warning: addresses that send under your
  name but are not configured (old addresses in archives), with the config snippet to add them.
- `status` / `mail_status` list Thunderbird's identity id (`tb_identity`, e.g. `id2`) for each own
  address, so agents can pick the sender in thunderbird-cli's `email_compose`/`email_reply`
  (thunderbird-cli exposes no identity ids over MCP, vitalio-sh/thunderbird-cli#30).

### Performance
- 64 MB page cache and memory-mapped reads; `to:me` driven by the address index. Against 0.1.0 on
  30k messages: people 171 → 127 ms, to:me 114 → 41 ms, from:me 53 → 21 ms, newest mail 63 → 28 ms.

### Changed
- Messages above `maxMessageBytes`: only attachments up to 2 MB are fetched individually.
- README: a simple overview diagram; note that Thunderbird is the bottleneck of the first sync.
- Skill: use donner for "newest mail" lists (thunderbird-cli's folder listing truncates before
  sorting, vitalio-sh/thunderbird-cli#15; donner's sync is not affected because it lists whole
  folders without sorting and bisects date windows when a listing is truncated).

## [0.2.0] — 2026-09-30

Changes from the first field test on a real mailbox (~70 000 messages, IMAP + local archive).
The index is upgraded automatically (schema 2); the next sync re-reads the affected messages.
Restart MCP clients and the background service after updating.

### Fixed
- HTML mails built with MJML and similar tools (`font-size:0` on wrappers, reset by children) lost
  all text. Only properties that really hide a subtree (`display:none`, `opacity:0`, zero-size
  overflow, clipping, off-screen) remove it; font size, colour and visibility are inherited and can
  be reset by children, as in a browser.
- PDF text: pdftotext (poppler) is used automatically when installed (sandboxed: memory limit,
  timeout, page cap). The built-in extractor now handles ASCII85/ASCIIHex/LZW streams, object
  streams and indirect font resources, and one unreadable stream no longer discards the document.
- `from:me` and everything that depends on "me" (people, contacts, direction, triage) knew only the
  first identity per account. donner now uses every identity of every account, senders found in
  sent folders at any depth (old addresses in archives) and `index.myAddresses`; spam that forges
  your address (failed authentication) is not "from me". `donner status` lists your addresses.
- `people`: the display name is the name an address uses most often as a sender; your own
  addresses are no longer listed as correspondents.
- Authentication-Results written as one header per method (some providers do this) are merged; one passing
  DKIM signature is enough.
- `is:suspicious` and result warnings flagged ~30 % of real mail: DMARC now decides sender
  authentication (`dkim=fail` with `dmarc=pass` is fine), and hidden text (newsletter preheaders)
  only counts from senders that are neither DMARC-authenticated nor contacts.
- Umlauts: the index stores ä/ö/ü/ß as ae/oe/ue/ss. `müller` now finds *Mueller*, and ASCII words no
  longer match wrong variants (`poet` found *pot*, `true` found *tru…*).
- `until:` is inclusive (`since:2025-01 until:2025-01` = January 2025); `before:` stays exclusive.
- Uppercase `AND` and `NOT` work as operators instead of being searched as words.
- Threads: replies without References or referencing messages that are not indexed are joined by
  subject when they share a participant other than you (within 60 days); existing threads are
  recomputed once.
- Calendar: only event data is indexed (no time-zone definitions from 1893, no alarm texts);
  cancellations, status and recurrence are stored. `has:invite` means real invitations; train
  tickets and bookings are `has:event`.
- Small attachments (≤ 2 MB, `largeMessageAttachmentBytes`) of messages above `maxMessageBytes` are
  fetched one by one instead of being skipped as too large.
- Raw 8-bit headers are read as Windows-1252 instead of showing "�"; leftover encoded words are
  decoded.
- Folders named like junk, trash or sent are recognised at any depth and with leading punctuation
  (`Uni/+spamverdacht`); `doctor` warns about indexed folders that look like spam.

### Added
- `donner threads` / MCP `mail_threads`: conversations with size, messages by you, first/last date
  and participants (`--min 4 --mine`, `with:person --sort first`).
- `count --by year,direction` — two grouping keys, and the key `direction` (sent/received).
- `has:event`, `has:cancelled`, `--sort event`, an `event` field in search results, recurring events
  in `event_after:`.
- `donner sync --reparse pdf|attachments|empty|hidden|calendar|headers|auth|large|all`.
- Tables `identities`, `contacts`; columns `messages.auth_verdict`, `events.method/status/rrule/uid/last_start`.

## [0.1.0] — 2026-09-30

First version (not published).

### Added
- Incremental sync from Thunderbird through the thunderbird-cli bridge: changed-folder detection,
  Message-ID based reconciliation (new / moved / deleted / flags / tags), folder renames as moves,
  resumable content download, Thunderbird restart (id epoch) detection, single-writer lock.
- SQLite FTS5 index over subject, participants, own text, quoted history and attachment text with
  column weights, prefix search and German umlaut/ß folding.
- Attachment text extraction: PDF (pdftotext or built-in), DOCX, XLSX, PPTX, ODF, ICS, VCF, HTML,
  forwarded messages — all size- and time-bounded.
- Gmail-style query language; commands `search`, `show`, `thread`, `count --by`, `people`,
  `attachment`, `sql`, `schema`, `status`, `doctor`, `resolve`, `sync`, `watch`, `service`,
  `config`, `skill`, `embed`, `reset`, `mcp`.
- Read-only SQL in a sandboxed child process.
- MCP server (stdio) with nine read-only tools and background auto-sync.
- Optional meaning-based and hybrid search with a local embedding model (Ollama or
  OpenAI-compatible; remote endpoints opt-in).
- Prompt-injection defences: hidden HTML content, comments and invisible Unicode removed and
  flagged; SPF/DKIM/DMARC and known-contact trust signals; untrusted-content notices.
- Agent skill (`skills/donner/SKILL.md`), systemd/launchd service installer, demo mode and
  benchmark against a simulated Thunderbird running the real thunderbird-cli bridge and extension.
- Query language with groups, OR between any terms, `with:`, `from:me`, `is:suspicious`,
  `is:authfail`, `has:invite`, `event_after:`/`event_before:`; umlaut-folded participant filters.
- Pre-release security review (docs/SECURITY-ANALYSIS.md) and usability study (docs/USABILITY.md);
  all findings addressed before release.
