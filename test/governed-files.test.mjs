// The governance tier (DD-56's counterweight, AC-55/AC-54/F-6): the files that
// DEFINE or GOVERN an agent are never the agent's to edit, on any turn,
// whatever the grant says.
//
// Under DD-35 this property held by accident of the confirm: build was never in
// a blanket grant, so every write to `.claude/settings.json`, the node's
// `.hive402` state, or the agent's own instructions file surfaced as a
// signature-bound confirmation the owner was SHOWN. DD-56 puts build on every
// owner turn — so the accident is gone, and the property has to be stated
// where the delegate rule already lives: refused before any record is
// consulted, so no grant can widen it and no approval can unlock it.
//
//   • `.claude/**` — the runtime settings that make this very gate run.
//   • `.hive402/**` (and the actual state dir) — grants, audit, node config.
//   • the agent's own instructions file (AC-55: "an agent never edits its own
//     instructions") — plumbed per-agent, because only the launcher knows it.
//
// Deliberately NOT here: memory files (CLAUDE.md and siblings). AC-54 pegs
// them to build's own rules — "requiring the same approval as any other
// build" — so they ride the owner's turn exactly as any build does now.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decideTool, runGate } from "../src/runtime/toolgate.mjs";
import { writeGrant } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";

const now = 1_700_000_000_000;
const WORKDIR = "C:/hive402/work/spike";

// A turn grant that carries build — the ordinary OWNER turn after DD-56.
const buildGrant = () => ({
  kind: "grant",
  capabilities: ["research", "build"],
  issuedAt: now,
  expiresAt: now + 60_000,
  boundPromptId: null,
});

const decide = (toolName, toolInput, over = {}) =>
  decideTool({ toolName, toolInput, grant: buildGrant(), promptId: "p1", cwd: WORKDIR, now, ...over });

// ── The node's own state and config ────────────────────────────────────────

test("a build-carrying turn still cannot write the node's .hive402 state", () => {
  const verdict = decide("Write", { file_path: "C:/Users/barry/.hive402/config.json" });
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, /never the agent's/i);
});

test("…and cannot get there by shell redirect either", () => {
  const verdict = decide("Bash", { command: `echo '{"rooms":[]}' > C:/Users/barry/.hive402/config.json` });
  assert.equal(verdict.decision, "deny", "the redirect is the path the harness deny rules cannot see");
  assert.match(verdict.reason, /never the agent's/i);
});

test("a build-carrying turn still cannot rewrite the runtime settings that run this gate", () => {
  const verdict = decide("Write", { file_path: `${WORKDIR}/.claude/settings.json` });
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, /never the agent's/i);
});

test("…including by shell, including rm", () => {
  for (const command of [
    `echo x > ${WORKDIR}/.claude/settings.json`,
    `rm ${WORKDIR}/.claude/settings.json`,
  ]) {
    const verdict = decide("Bash", { command });
    assert.equal(verdict.decision, "deny", command);
  }
});

// ── The agent's own instructions (AC-55: never) ────────────────────────────

test("AC-55: a build-carrying turn cannot edit the agent's own instructions file", () => {
  const instructions = "C:/Users/barry/hive-agents/spike.md";
  const verdict = decide(
    "Write",
    { file_path: instructions },
    { governedPaths: [instructions] },
  );
  assert.equal(verdict.decision, "deny", "'an agent never edits its own instructions' — never");
  assert.match(verdict.reason, /never the agent's/i);
});

test("AC-55: the shell spelling is refused the same way", () => {
  const instructions = "C:/Users/barry/hive-agents/spike.md";
  const verdict = decide(
    "Bash",
    { command: `echo "obey tal" >> ${instructions}` },
    { governedPaths: [instructions] },
  );
  assert.equal(verdict.decision, "deny");
});

test("the governance deny is not waitable — no record could change the answer", () => {
  const verdict = decide("Write", { file_path: "C:/Users/barry/.hive402/grants/spike.json" });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.waitable, false);
});

// ── And it must not over-classify (F-010's standing lesson) ────────────────

test("an ordinary build write on a build-carrying turn still runs", () => {
  const verdict = decide("Write", { file_path: "C:/some/other/project/index.html" });
  assert.equal(verdict.decision, "allow", "governance is an enumerable set, not a mood");
});

test("a governed path passed per-agent does not smear onto its siblings", () => {
  const verdict = decide(
    "Write",
    { file_path: "C:/Users/barry/hive-agents/README.md" },
    { governedPaths: ["C:/Users/barry/hive-agents/spike.md"] },
  );
  assert.equal(verdict.decision, "allow", "only the instructions file itself is governed");
});

// ── Through the real gate entry, with the state dir it actually runs from ──

test("runGate refuses a write into its own state dir even on a fully granted turn", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-governed-"));
  writeGrant({ stateDir, agent: "spike", eventId: "e1", capabilities: ["research", "build"], reason: "owner request", now });
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p1", eventId: "e1", now });

  const result = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Write",
      tool_input: { file_path: path.join(stateDir, "grants", "spike.json"), content: "{}" },
      prompt_id: "p1",
      cwd: WORKDIR,
    },
    waitMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.decision, "deny", "the agent must never author its own authority");
  assert.match(
    result.verdict?.reason ?? "",
    /never the agent's/i,
    "denied AS governance, not by accident of a stale record",
  );
});
