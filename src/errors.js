// Error type with a machine-readable code and an optional human hint.

export class DonnerError extends Error {
  /**
   * @param {string} code  stable, SCREAMING_SNAKE error code (part of the CLI/MCP contract)
   * @param {string} message
   * @param {string} [hint] what the user can do about it
   */
  constructor(code, message, hint) {
    super(message);
    this.name = "DonnerError";
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAVAILABLE: 3, // bridge / Thunderbird not reachable
  NO_INDEX: 4,
});

export function exitCodeFor(err) {
  switch (err?.code) {
    case "INVALID_ARGS":
    case "UNKNOWN_COMMAND":
      return EXIT.USAGE;
    case "BRIDGE_UNREACHABLE":
    case "EXTENSION_DISCONNECTED":
    case "AUTH_REQUIRED":
    case "TIMEOUT":
      return EXIT.UNAVAILABLE;
    case "NO_INDEX":
      return EXIT.NO_INDEX;
    default:
      return EXIT.ERROR;
  }
}
