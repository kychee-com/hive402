import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildClaudeSettings, writeAgentRuntimeConfig } from "../src/launcher/capabilities.mjs";

const base = { name: "spike", ownerPubkey: "a".repeat(64) };
const agent = (over) => ({ ...base, research: false, build: false, ...over });

const denied = (a) => buildClaudeSettings({ agent: a }).permissions.deny.join(" ");

// Every real launch wires the per-turn tool gate (DD-15) and the turn gate
// (DD-19); the write path refuses without them, so tests that exercise the
// write path supply them — and supply the REAL scripts, because the write path
// also refuses a hook that points at a file which is not there.
const TEST_GATE = {
  nodeBin: "node",
  script: fileURLToPath(new URL("../src/runtime/toolgate.mjs", import.meta.url)),
  turnScript: fileURLToPath(new URL("../src/runtime/turngate.mjs", import.meta.url)),
  stateDir: "/state",
};

// AC-17: an action the agent is not capability-enabled for is refused EVEN
// WHEN asked or approved. Cycle 1 (F-003) found the opposite: a non-owner asked
// for research and got a live external API call back in 42 seconds. The agent's
// own report was that it could find "no capability toggle... gated by the
// session permission mode on your side rather than by a feature flag I can
// see" — i.e. nothing was enforcing anything. Prompting is not enforcement;
// removing the tool is.
test("research=off removes the web tools entirely", () => {
  const d = denied(agent({ research: false }));
  assert.match(d, /WebSearch/);
  assert.match(d, /WebFetch/);
});

test("build=off removes the tools that write, edit or build", () => {
  const d = denied(agent({ build: false }));
  for (const tool of ["Write", "Edit", "NotebookEdit", "git", "npm", "run402"]) {
    assert.match(d, new RegExp(tool), `expected ${tool} to be denied`);
  }
});

test("build=off does NOT deny Bash outright, which would make the agent mute", () => {
  // REGRESSION (found live, 2026-08-15): an agent replies by RUNNING
  // `buzz messages send` — Buzz discards its plain text. A bare `Bash` denial
  // therefore produces an agent that wakes and never speaks. Deny rules win
  // over allow rules, so no allowlist entry can rescue it.
  const deny = buildClaudeSettings({ agent: agent({ build: false }) }).permissions.deny;
  assert.ok(!deny.includes("Bash"), `bare Bash must not be denied, got: ${deny.join(", ")}`);
});

test("enabling research lifts exactly the web denials and nothing else", () => {
  const off = buildClaudeSettings({ agent: agent({ research: false, build: false }) });
  const on = buildClaudeSettings({ agent: agent({ research: true, build: false }) });
  const lifted = off.permissions.deny.filter((r) => !on.permissions.deny.includes(r));
  assert.ok(lifted.length > 0);
  assert.ok(
    lifted.every((r) => /WebSearch|WebFetch|curl|wget|Invoke-WebRequest|Invoke-RestMethod/.test(r)),
    `lifted too much: ${lifted}`,
  );
});

test("enabling build lifts exactly the build denials and nothing else", () => {
  const off = buildClaudeSettings({ agent: agent({ research: false, build: false }) });
  const on = buildClaudeSettings({ agent: agent({ research: false, build: true }) });
  const lifted = off.permissions.deny.filter((r) => !on.permissions.deny.includes(r));
  assert.ok(lifted.length > 0);
  assert.ok(
    lifted.every((r) => /Write|Edit|NotebookEdit|git|npm|npx|node|python|py|pip|cargo|make|docker|run402/.test(r)),
    `lifted too much: ${lifted}`,
  );
  assert.ok(
    !lifted.some((r) => /WebSearch|WebFetch/.test(r)),
    "enabling build must not enable research",
  );
});

test("a fully enabled agent still cannot reach the tools that would rewrite its own policy", () => {
  // Defence in depth: an agent that can write files must not be able to edit
  // the settings file that constrains it, or the capability toggle becomes
  // advisory the moment build is enabled.
  const d = denied(agent({ research: true, build: true }));
  assert.match(d, /settings\.json/);
});

test("the agent keeps the tool it speaks with, whatever its capabilities", () => {
  // The agent replies by RUNNING `buzz messages send` (spike finding). Denying
  // Bash outright for a build-disabled agent would make it mute — the exact
  // "👀 forever" failure the launcher fix exists to prevent. So the buzz CLI is
  // allowed explicitly even while general Bash is denied.
  const settings = buildClaudeSettings({ agent: agent({ build: false }) });
  assert.ok(
    settings.permissions.allow.some((r) => /buzz/i.test(r)),
    "expected the buzz CLI to remain allowed",
  );
});

test("each agent gets its own settings directory, never a shared one", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hive402-caps-"));
  const a = writeAgentRuntimeConfig({ agent: agent({ name: "spike" }), root, gate: TEST_GATE });
  const b = writeAgentRuntimeConfig({ agent: agent({ name: "blitz" }), root, gate: TEST_GATE });
  assert.notEqual(a.workDir, b.workDir);
});

test("settings are written as PROJECT settings, so the owner's credential dir is untouched", () => {
  // REGRESSION (found live, 2026-08-15): pointing CLAUDE_CONFIG_DIR at a fresh
  // per-agent dir also moved the runtime's CREDENTIALS, and every turn failed
  // with "Authentication required". Per-agent policy must travel through the
  // working directory, not the config directory.
  const root = mkdtempSync(path.join(tmpdir(), "hive402-caps-"));
  const { workDir, settingsFile } = writeAgentRuntimeConfig({ agent: agent(), root, gate: TEST_GATE });
  assert.equal(settingsFile, path.join(workDir, ".claude", "settings.json"));
});

test("the settings file written to disk is what the runtime will actually read", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hive402-caps-"));
  const { settingsFile } = writeAgentRuntimeConfig({ agent: agent({ research: false }), root, gate: TEST_GATE });
  const onDisk = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.ok(onDisk.permissions.deny.some((r) => /WebSearch/.test(r)));
});

test("re-launching an agent with a capability enabled rewrites the settings rather than stacking", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hive402-caps-"));
  writeAgentRuntimeConfig({ agent: agent({ research: false }), root, gate: TEST_GATE });
  const { settingsFile } = writeAgentRuntimeConfig({ agent: agent({ research: true }), root, gate: TEST_GATE });
  const onDisk = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.ok(!onDisk.permissions.deny.some((r) => /WebSearch/.test(r)));
});

// ── The per-turn tool gate (DD-15, fix cycle 2) ────────────────────────────
//
// The static denials above are permanent: they express what the OWNER enabled.
// They cannot express "…but only when this turn is authorised", because they
// are read once when the runtime session starts. F-007 lived in exactly that
// gap — spike's `research` was genuinely on, so the capability wall had nothing
// to say when a non-owner's cleverly-worded request produced a live web fetch.
// The hook below adds the missing dimension: WHOSE turn is this?

const GATE = {
  // Spaces on purpose: on Windows both node and the state dir routinely sit
  // under "Program Files" / a user profile, so the generated command must quote
  // them or the hook silently fails to run and the gate is not there at all.
  nodeBin: "C:/Program Files/nodejs/node.exe",
  script: "C:/hive402 checkout/src/runtime/toolgate.mjs",
  stateDir: "C:/Users/some one/.hive402",
};

const hooksOf = (a) => buildClaudeSettings({ agent: a, gate: GATE }).hooks;

test("the settings declare a PreToolUse hook that runs the gate", () => {
  const pre = hooksOf(agent({ research: true }))?.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length === 1, "expected exactly one PreToolUse matcher group");
  assert.equal(pre[0].matcher, "*", "the gate must see EVERY tool call, not a subset");
  const command = pre[0].hooks[0].command;
  assert.match(command, /toolgate\.mjs/);
  assert.match(command, /--agent spike/);
  assert.match(command, /--state /);
});

test("the hook is declared with absolute paths — the agent's PATH is not trusted for it", () => {
  const command = hooksOf(agent({}))?.PreToolUse[0].hooks[0].command;
  assert.ok(command.startsWith(`"${GATE.nodeBin}"`), `expected an absolute node path, got: ${command}`);
  assert.ok(command.includes(GATE.script), "the gate script must be referenced absolutely");
  assert.ok(command.includes(`"${GATE.stateDir}"`), "the state dir must be quoted — it contains spaces on Windows");
});

// ── The turn admission hook (DD-19, fix cycle 3) ───────────────────────────
//
// The tool gate answers "may this turn do that?". It cannot answer "whose turn
// is this?", because the node is not on the path when the harness delivers an
// owner's message straight to their agent. This hook is what closes that gap:
// the runtime states its own trigger at the start of every turn.

test("the settings declare a UserPromptSubmit hook that runs the turn gate", () => {
  const ups = hooksOf(agent({ research: true }))?.UserPromptSubmit;
  assert.ok(Array.isArray(ups) && ups.length === 1, "expected exactly one UserPromptSubmit matcher group");
  assert.equal(ups[0].matcher, "*", "every turn must be seen, not a subset");
  const command = ups[0].hooks[0].command;
  assert.match(command, /turngate\.mjs/);
  assert.match(command, /--agent spike/);
  assert.match(command, /--state /);
  assert.ok(command.startsWith(`"${GATE.nodeBin}"`), `expected an absolute node path, got: ${command}`);
  assert.ok(command.includes(`"${GATE.stateDir}"`), "the state dir must be quoted — it contains spaces on Windows");
});

test("the turn hook is declared even for an agent with every capability off", () => {
  // A zero-capability agent still needs its turns attributed and counted: it
  // converses, and AC-26 caps its turns like everyone else's.
  assert.ok(hooksOf(agent({ research: false, build: false }))?.UserPromptSubmit);
});

test("the gate is declared even for an agent with every capability off", () => {
  // Belt and braces: a capability can be turned ON from chat between launches,
  // and a settings file written without the hook would silently lose per-turn
  // containment for the rest of that process's life.
  assert.ok(hooksOf(agent({ research: false, build: false }))?.PreToolUse);
});

test("writing a runtime config pointing at a MISSING gate script is refused", () => {
  // Same failure as omitting the wiring, one level subtler: a hook whose
  // command names a script that is not there runs, fails, and the runtime
  // carries on ungated. Nothing in the settings file looks wrong.
  const root = mkdtempSync(path.join(tmpdir(), "hive402-ghostgate-"));
  assert.throws(
    () =>
      writeAgentRuntimeConfig({
        agent: agent({}),
        root,
        gate: { nodeBin: "node", script: "/nowhere/toolgate.mjs", stateDir: "/state" },
      }),
    /toolgate\.mjs|does not exist/i,
  );
  rmSync(root, { recursive: true, force: true });
});

test("writing a runtime config WITHOUT gate wiring is refused, not silently ungated", () => {
  // The one failure mode that must never be quiet. A settings file with no hook
  // looks completely normal and contains nothing to notice.
  const root = mkdtempSync(path.join(tmpdir(), "hive402-nogate-"));
  assert.throws(
    () => writeAgentRuntimeConfig({ agent: agent({}), root }),
    /gate/i,
  );
});

test("the agent cannot read or write the directory its own grants live in", () => {
  // If the agent could edit its grant file, the gate would be advisory.
  const deny = buildClaudeSettings({ agent: agent({ research: true, build: true }), gate: GATE }).permissions.deny;
  assert.ok(deny.some((r) => /Read\(\*\*\/\.hive402/.test(r)));
  assert.ok(deny.some((r) => /Write\(\*\*\/\.hive402/.test(r)));
});

test("capability denials cover the PowerShell tool as well as Bash", () => {
  // The static list only ever named Bash. If the runtime exposes a PowerShell
  // tool, `Bash(curl:*)` says nothing about `PowerShell → curl`.
  const d = denied(agent({ research: false }));
  assert.match(d, /PowerShell\(curl/);
  const b = denied(agent({ build: false }));
  assert.match(b, /PowerShell\(git/);
});

test("the agent's voice is allowed through PowerShell too", () => {
  const allow = buildClaudeSettings({ agent: agent({}), gate: GATE }).permissions.allow.join(" ");
  assert.match(allow, /PowerShell\(buzz/);
});

test("the turn hook carries AC-26's cap, so the fuse lives where the turns arrive", () => {
  const withCap = buildClaudeSettings({
    agent: agent({}),
    gate: { ...GATE, turnCap: { limit: 20, windowMs: 3600000 } },
  }).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(withCap, /--turn-cap 20/);
  assert.match(withCap, /--turn-window 3600000/);

  // No cap configured means no cap enforced — never a silent default.
  assert.ok(!/--turn-cap/.test(hooksOf(agent({})).UserPromptSubmit[0].hooks[0].command));
});
