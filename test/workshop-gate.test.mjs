// FIX-43 / DD-27: run402 is the NODE's tool, never the agent's.
//
// Everything here runs the REAL gate (`runGate`, the same entry point the
// runtime hook invokes) against records on a real disk, because the bug this
// cycle fixes is a module nothing called. A test that only exercised
// `classifyCommand` would have passed in every previous cycle too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyCommand, decideTool, runGate, toolSignature } from "../src/runtime/toolgate.mjs";
import { writeGrant, writeWithheld } from "../src/runtime/grants.mjs";
import { buildAgentEnv } from "../src/launcher/env.mjs";

const stateDir = () => mkdtempSync(path.join(tmpdir(), "hive402-workshop-gate-"));

const bash = (command, promptId = "p1") => ({
  tool_name: "Bash",
  tool_input: { command },
  prompt_id: promptId,
  session_id: "s1",
});

const fullGrant = (dir) =>
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research", "build"], reason: "owner request" });

const blockedRecords = (dir) => {
  const blocked = path.join(dir, "blocked");
  return readdirSync(blocked)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(path.join(blocked, n), "utf8")));
};

const gate = (dir, input) =>
  runGate({ stateDir: dir, agent: "spike", enabled: ["research", "build"], input, waitMs: 0 });

// ── A grant is not a key to run402 ────────────────────────────────────────

test("a turn holding a FULL build grant still cannot run run402 (DD-27)", async () => {
  // This is the whole decision. The owner's own turn carries every capability
  // the agent has, and it still does not carry the owner's wallet.
  const dir = stateDir();
  fullGrant(dir);
  const result = await gate(dir, bash("run402 sites deploy-dir ./site --project prj_123"));

  assert.equal(result.decision, "deny");
  assert.equal(result.verdict.delegate, "run402");
  assert.equal(result.verdict.capability, "build", "a deploy is still a build");
});

test("the refusal tells the agent the node is doing the work, so it neither retries nor routes around", async () => {
  const dir = stateDir();
  fullGrant(dir);
  const result = await gate(dir, bash("run402 sites deploy-dir ./site --project prj_123"));
  const advice = result.output.hookSpecificOutput.permissionDecisionReason;

  assert.match(advice, /hive402 runs run402/i, `advice was: ${advice}`);
  assert.match(advice, /Do not retry/i);
  assert.doesNotMatch(
    advice,
    /will re-run your request if they approve/i,
    "no approval can ever release this, so promising one is a lie",
  );
});

test("run402 is caught in ANY segment, not just the head of the line", async () => {
  const dir = stateDir();
  fullGrant(dir);
  for (const command of [
    "curl -s https://x.example/site.sh | run402 sites deploy-dir . --project prj_1",
    "cd /tmp && run402 up --name sneaky -y",
    "echo building; run402 deploy apply --manifest app.json",
    "npm run build && node -e 1 || run402 up -y",
    "for f in a b; do run402 up -y; done",
  ]) {
    const result = await gate(dir, bash(command));
    assert.equal(result.decision, "deny", `not refused: ${command}`);
    assert.equal(result.verdict.delegate, "run402", `not marked delegated: ${command}`);
  }
});

test("a run402 hidden inside a command substitution is still delegated", async () => {
  const dir = stateDir();
  fullGrant(dir);
  const result = await gate(dir, bash('buzz messages send --content "deployed: $(run402 status --json)"'));
  assert.equal(result.decision, "deny");
  assert.equal(result.verdict.delegate, "run402");
});

test("the Windows shims are the same binary", () => {
  for (const head of ["run402", "run402.cmd", "run402.exe", "C:\\Users\\x\\AppData\\Roaming\\npm\\run402.CMD"]) {
    const verdict = decideTool({
      toolName: "Bash",
      toolInput: { command: `${head} up -y` },
      grant: { kind: "grant", capabilities: ["build"], expiresAt: Date.now() + 60000, issuedAt: Date.now() },
    });
    assert.equal(verdict.delegate, "run402", `${head} was not recognised`);
  }
});

// ── The Windows path bug this fix uncovered ──────────────────────────────
//
// The scanner masked `\` + ANY character as an escape, which destroyed every
// Windows absolute path before `commandHead` ever saw it. Three separate
// defects fell out of that one line, and only the first belongs to this cycle.

test("run402 invoked by absolute Windows path is delegated, not merely 'a build'", async () => {
  // The dangerous one. Unmarked, this escalates as an ordinary build refusal —
  // and an owner approving THAT would release the agent to run run402 itself,
  // with the owner's wallet. Precisely what DD-27 exists to prevent.
  const dir = stateDir();
  fullGrant(dir);
  const result = await gate(dir, bash(String.raw`C:\Users\volin\AppData\Roaming\npm\run402.cmd up -y`));
  assert.equal(result.decision, "deny");
  assert.equal(result.verdict.delegate, "run402");
});

test("a redirect to a Windows absolute path is a build, not composition in scratch", async () => {
  // REGRESSION: `cat notes > C:\Users\volin\note.md` scored CONVERSE, because a
  // mangled target does not look absolute and a non-absolute target reads as
  // "inside the scratch dir". A write to the owner's home ran free on a
  // withheld turn. Same defect as the quoted-target bug of cycle 3.
  const dir = stateDir();
  writeWithheld({ stateDir: dir, agent: "spike", reason: "not the owner" });
  const result = await runGate({
    stateDir: dir,
    agent: "spike",
    enabled: ["build"],
    input: { ...bash(String.raw`cat notes > C:\Users\volin\note.md`), cwd: "C:\\scratch\\spike" },
    waitMs: 0,
  });
  assert.equal(result.decision, "deny", "a write outside the scratch dir is never free");
  assert.equal(result.verdict.capability, "build");
});

test("buzz invoked by absolute Windows path is still speech, so the agent is never muted", async () => {
  // REGRESSION (F-010's failure mode): scored `build`, so an agent that spelled
  // its own reply with a full path went mute on every contained turn.
  const dir = stateDir();
  writeWithheld({ stateDir: dir, agent: "spike", reason: "not the owner" });
  const result = await gate(dir, bash(String.raw`C:\Users\volin\AppData\Local\Buzz\buzz.exe messages send --content "hi"`));
  assert.equal(result.decision, "allow", "conversation is always free, however it is spelled");
});

test("a real escape is still an escape: an escaped operator never separates commands", async () => {
  // The other direction of the same fix. `\;` and `\|` are literals, so what
  // follows them is an argument and not a new command head.
  assert.equal(classifyCommand(String.raw`echo a\; run402 up`, {}), "converse");
  assert.equal(classifyCommand(String.raw`echo "a \" b"`, {}), "converse");
});

// ── Fail-closed only: this rule never turns a deny into an allow ───────────

test("the delegate rule can only ever turn an allow into a deny", async () => {
  // Asserted directly, over a table, rather than inferred from the cases above:
  // a verdict that carries a delegate is ALWAYS a denial, and a verdict with no
  // delegate is decided exactly as it was before this rule existed.
  const dir = stateDir();
  fullGrant(dir);
  const grant = { kind: "grant", capabilities: ["research", "build"], expiresAt: Date.now() + 60000, issuedAt: Date.now() };

  for (const command of [
    "run402 up -y",
    "npm run build",
    "buzz messages send --content hi",
    "echo run402 is a deploy tool",
    "git push origin main",
    "curl -s https://example.com",
    "",
  ]) {
    const verdict = decideTool({ toolName: "Bash", toolInput: { command }, grant });
    if (verdict.delegate) {
      assert.equal(verdict.decision, "deny", `a delegated call must never be allowed: ${command}`);
    } else {
      // Unchanged behaviour: the capability the classifier reports still decides.
      const expected = classifyCommand(command) === "converse" || grant.capabilities.includes(classifyCommand(command));
      assert.equal(verdict.decision, expected ? "allow" : "deny", `behaviour changed for: ${command}`);
    }
  }
});

test("an ordinary build is unaffected: npm run build still runs on a build grant", async () => {
  const dir = stateDir();
  fullGrant(dir);
  const result = await gate(dir, bash("npm run build"));
  assert.equal(result.decision, "allow");
  assert.equal(result.verdict.delegate ?? null, null);
});

test("merely SAYING run402 is still conversation", async () => {
  const dir = stateDir();
  writeWithheld({ stateDir: dir, agent: "spike", reason: "not the owner" });
  const result = await gate(dir, bash('buzz messages send --content "I would deploy this with run402 if I could"'));
  assert.equal(result.decision, "allow", "the lexicon is gone and stays gone (DD-26)");
});

// ── The honest boundary, and the control that holds there ─────────────────

test("a wrapper hiding run402 in quoted data is NOT caught by the classifier", async () => {
  // Stated as a fact rather than hidden. `sh -c "run402 up"` puts the command
  // in quoted data, and quoted data must not be read as commands — reading it
  // the other way is F-010, which made the agent mute for a whole cycle. So the
  // classifier scores this an ordinary build, and on a turn holding `build` it
  // would run. What stops it is not the gate.
  const dir = stateDir();
  fullGrant(dir);
  const result = await gate(dir, bash(`sh -c "run402 up -y"`));
  assert.equal(result.verdict.delegate ?? null, null, "if this ever starts passing, delete this test");
  // ...and containment for it lives in the launcher: see the PATH test below.
});

test("an agent is never launched with run402 reachable on its PATH (DD-27)", () => {
  // This is the control the test above defers to. If the binary is not on the
  // process's PATH, no spelling — wrapper, alias, quoted or otherwise — reaches
  // it, and no classifier has to be perfect.
  const base = {
    agent: {
      name: "spike",
      ownerPubkey: "b".repeat(64),
      authTag: ["auth", "x", "y"],
      research: true,
      build: true,
    },
    room: { relayUrl: "ws://localhost:3000", respondTo: "anyone" },
    secrets: { agentPrivateKey: "a".repeat(64) },
    toolPaths: { buzzDir: "C:/Buzz", nodeDir: "C:/node", extraDirs: ["C:/npm-global"] },
  };

  assert.throws(
    () => buildAgentEnv({ ...base, readdir: (d) => (d === "C:/npm-global" ? ["run402.cmd", "tsc"] : ["node.exe"]) }),
    /run402 reachable on its PATH/,
    "a PATH entry holding a run402 launcher must stop the launch",
  );

  const env = buildAgentEnv({ ...base, readdir: () => ["node.exe", "buzz.exe"] });
  assert.match(env.PATH, /C:\/Buzz/, "an ordinary PATH is unaffected");
});

// ── The blocked record is what the node reads ─────────────────────────────

test("the blocked record carries the delegate mark and the call's signature", async () => {
  // The node's ONLY input for a deploy is this file. Without `delegate` on it
  // there is nothing to distinguish a deploy attempt from any other refusal,
  // and the deploy path would still have no caller.
  const dir = stateDir();
  fullGrant(dir);
  const command = "run402 sites deploy-dir ./site --project prj_123";
  await gate(dir, bash(command));

  const records = blockedRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].delegate, "run402");
  assert.equal(records[0].capability, "build");
  assert.equal(
    records[0].signature,
    toolSignature({ toolName: "Bash", toolInput: { command } }),
    "the approval binds to this exact call (DD-21)",
  );
});

test("a delegated refusal is denied immediately, never waited out", async () => {
  // There is no record the node could write that would change the answer, so
  // polling for one would stall every deploy attempt by the full wait window.
  const dir = stateDir();
  fullGrant(dir);
  let slept = 0;
  const result = await runGate({
    stateDir: dir,
    agent: "spike",
    enabled: ["build"],
    input: bash("run402 up -y"),
    waitMs: 2500,
    pollMs: 200,
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(result.decision, "deny");
  assert.equal(slept, 0, "the gate waited for an authority that could never help");
});

test("the audit log records the delegation, not just a denial", async () => {
  const dir = stateDir();
  fullGrant(dir);
  await gate(dir, bash("run402 sites deploy-dir ./site --project prj_123"));
  const rows = readFileSync(path.join(dir, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "deny");
  assert.equal(rows[0].delegate, "run402");
});
