// What the gate TELLS the agent when it refuses (found by running it, cycle 2).
//
// The first live re-test contained F-007 correctly — no fetch happened — but it
// ended in a dead end. spike chose to implement "what's on the HN front page?"
// as a shell pipeline (`curl … | node -e …`). `node` is a build tool and spike
// has build=false, so the refusal was AC-17's permanent one: no approval token,
// owner never asked. The requester got "no" and the owner never learned anyone
// had wanted anything.
//
// spike had `research=true` the whole time. Had it reached for WebFetch instead,
// the refusal would have been the temporary kind and the owner would have been
// asked. So the gate has to say WHICH kind of refusal this is, and what the
// agent could use instead — the node knows, and it costs nothing to pass on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGate } from "../src/runtime/toolgate.mjs";
import { writeWithheld } from "../src/runtime/grants.mjs";

const state = () => mkdtempSync(path.join(tmpdir(), "hive402-guide-"));
const now = 1_700_000_000_000;
const nowait = { sleep: async () => {}, waitMs: 0 };

const reasonFor = async ({ command, toolName = "Bash", enabled }) => {
  const dir = state();
  writeWithheld({ stateDir: dir, agent: "spike", reason: "non-owner turn", now });
  const result = await runGate({
    stateDir: dir,
    agent: "spike",
    enabled,
    input: { tool_name: toolName, tool_input: command ? { command } : { url: "https://x" }, prompt_id: "p1" },
    now,
    ...nowait,
  });
  return result.output.hookSpecificOutput.permissionDecisionReason;
};

test("a capability the owner DISABLED is named as permanently off, not as pending approval", async () => {
  const reason = await reasonFor({ command: "node -e \"x\"", enabled: ["research"] });
  assert.match(reason, /disabled/i);
  assert.match(reason, /cannot be approved/i, "AC-17: chat cannot unlock a capability the owner switched off");
  assert.ok(
    !/already asked your owner/i.test(reason),
    `must not claim an approval is pending when none was raised: ${reason}`,
  );
});

test("a disabled build points the agent at the capability it DOES have", async () => {
  // This is the whole fix: spike wanted to read a web page and picked a shell
  // pipeline. Telling it that research exists turns a dead end into an approval.
  const reason = await reasonFor({ command: "curl -s https://x | node -e \"y\"", enabled: ["research"] });
  assert.match(reason, /WebFetch|research/i);
});

test("a capability that is ENABLED but not granted this turn says the owner has been asked", async () => {
  const reason = await reasonFor({ toolName: "WebFetch", enabled: ["research"] });
  assert.match(reason, /owner/i);
  assert.ok(!/disabled/i.test(reason), `an enabled capability must not read as disabled: ${reason}`);
});

test("with nothing enabled at all, the agent is told plainly rather than pointed nowhere", async () => {
  const reason = await reasonFor({ command: "node -e \"x\"", enabled: [] });
  assert.match(reason, /disabled/i);
  assert.ok(!/WebFetch/.test(reason), "do not suggest a tool this agent does not have");
});

test("the agent is always told not to route around the refusal", async () => {
  for (const enabled of [[], ["research"], ["research", "build"]]) {
    const reason = await reasonFor({ toolName: "WebFetch", enabled });
    assert.match(reason, /do not retry|not.*route around/i);
  }
});

// ── The refusal must not read as a dead end when it is not one (FIX-30) ────
//
// Cycle 3's room saw `@spike cannot do that: capability "build" is disabled for
// spike` posted for a turn that was WITHHELD, not for a capability the owner had
// switched off. Those are opposite situations: one is permanent and no approval
// can change it (AC-17), the other is the approval AC-14 exists for. A reader of
// the room would reasonably conclude the owner could not fix it either.

test("a withheld turn is described as awaiting approval, not as a disabled capability", async () => {
  const reason = await reasonFor({ command: "git status", enabled: ["research", "build"] });
  assert.match(reason, /approval|approve/i);
  assert.ok(!/disabled/i.test(reason), `a withheld turn must not read as switched-off: ${reason}`);
});

test("a genuinely disabled capability still says so, and offers no false hope", async () => {
  const reason = await reasonFor({ command: "git status", enabled: ["research"] });
  assert.match(reason, /disabled/i);
});

test("a refused agent is told how it can still speak", async () => {
  // AC-7 is only satisfiable if the agent knows a working way to say "I was
  // refused". Being refused for quoting is the one case where it might not.
  const reason = await reasonFor({
    command: "buzz messages send --channel x --content 'I can't run that; it is gated'",
    enabled: ["research", "build"],
  });
  assert.match(reason, /heredoc|double quote/i, `expected a usable alternative, got: ${reason}`);
});
