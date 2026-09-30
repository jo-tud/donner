// The query language is documented in four places; keep them in sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { QUERY_HELP } from "../../src/query.js";
import { TOOLS } from "../../src/mcp.js";
import { ROOT } from "../helpers.js";

const CANONICAL = ["from:", "to:", "cc:", "bcc:", "with:", "subject:", "body:", "filename:", "has:", "in:", "folder:", "account:", "is:", "after:", "before:", "newer_than:", "older_than:", "event_after:", "event_before:", "tag:", "list:", "thread:", "larger:", "smaller:", "id:", "mid:"];
const VALUES = ["is:suspicious", "is:hidden", "is:unread", "has:invite", "has:pdf", "has:xlsx", "has:ics", "from:me"];

test("every operator is documented in help, MCP, README and SKILL.md", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const skill = readFileSync(join(ROOT, "skills", "donner", "SKILL.md"), "utf8");
  const mcp = TOOLS.find((t) => t.name === "mail_search").description;
  for (const [name, doc] of [["QUERY_HELP", QUERY_HELP], ["MCP", mcp], ["README", readme], ["SKILL.md", skill]]) {
    for (const op of [...CANONICAL, ...VALUES]) assert.ok(doc.includes(op), `${name} does not mention ${op}`);
  }
});

test("every entry of package.json \"files\" exists", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const f of pkg.files) assert.ok(existsSync(join(ROOT, f)), f);
});
