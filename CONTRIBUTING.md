# Contributing

Thanks for helping! donner aims to stay small, dependency-light and safe with hostile input.

## Setup

```bash
git clone https://github.com/jo-tud/donner && cd donner
npm install
npm test            # ~15 s; no Thunderbird needed
npm run demo        # interactive try-out against a simulated Thunderbird
```

Node.js ≥ 22.13 is required (built-in SQLite).

## Guidelines

- **No new runtime dependencies** without discussion. Each one is attack surface for a tool that reads everyone's mail.
- **Treat mail as hostile.** Anything that parses mail or attachments must be bounded in size and time and must not use regular expressions with nested quantifiers on untrusted input.
- **stdout is an API.** JSON mode prints exactly one `{"ok":…}` document; the MCP server prints only protocol messages. Logs and progress go to stderr. `npm run check` rejects `console.log` in `src/`.
- **donner is read-only** towards Thunderbird. Actions belong in thunderbird-cli.
- Error codes (`NO_INDEX`, `BRIDGE_UNREACHABLE`, …) and JSON field names are part of the public contract; change them only with a CHANGELOG entry.
- Add tests: unit tests in `test/unit/`, end-to-end behaviour in `test/integration/` using the harness. New mail features should get a case in `test/fixtures/corpus.js`.
- Style: ES modules, 2-space indent, small functions, comments that explain *why*.

## Updating the vendored thunderbird-cli code

`test/vendor/thunderbird-cli/` contains `bridge.js`, `background.js` and `thread-utils.js` from
[thunderbird-cli](https://github.com/vitalio-sh/thunderbird-cli) (MIT). Update them from a release
and run the tests; the harness only patches the WebSocket port.

## Reporting security issues

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
