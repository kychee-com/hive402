// DD-56 (spec 0.7.0): `build` never rides a NON-owner's automatic turn grant —
// and rides the owner's own turn freely.
//
// This file used to pin DD-35's stronger rule (build confirms for everyone).
// Spec 0.7.0 retired the owner half of that: F-019's bill — a run402 project
// and a public subdomain committed with nothing to say yes to — was always the
// DEPLOY's doing, and the deploy still confirms once, as its own proposal. The
// invariant that stays, stated once in `NEVER_AUTO_CROSS_OWNER` and asserted
// over every branch that issues a grant without an approval behind it: a
// stranger's turn never holds `build` by default, auto-allow included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";
import {
  NEVER_AUTO_CROSS_OWNER,
  automaticCapabilities,
  ownerTurnCapabilities,
  writeGrant,
} from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";
import { runGate, toolSignature } from "../src/runtime/toolgate.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const OTHER = "cc".repeat(32);
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

const spike = (over = {}) => ({
  name: "spike",
  pubkey: SPIKE,
  ownerPubkey: OWNER,
  research: true,
  build: true,
  crossOwnerAsks: "owner-approves",
  replyMode: "addressed-only",
  ...over,
});

function make(over = {}) {
  const audit = new AuditLog();
  const agents = [spike(over)];
  return {
    agents,
    dispatcher: new Dispatcher({
      nodePubkey: NODE,
      agents,
      turnCap: new TurnCap({ limit: 20 }),
      loopGuard: new LoopGuard(),
      audit,
      workshop: { project: "prj_x", subdomain: null },
    }),
  };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "@spike do the thing", tags: [], ...over });
const authorityOf = (fx) =>
  fx.find((e) => e.type === "authority") ?? fx.find((e) => e.type === "wake")?.authority ?? null;

test("the split AC-16 0.7.0 draws, and both capability sets honour it", () => {
  assert.deepEqual([...NEVER_AUTO_CROSS_OWNER], ["build"]);
  // The owner's word is the whole gate: everything enabled, nothing more.
  assert.deepEqual(ownerTurnCapabilities({ research: true, build: true }), ["research", "build"]);
  assert.deepEqual(ownerTurnCapabilities({ research: true, build: false }), ["research"]);
  assert.deepEqual(ownerTurnCapabilities({ research: false, build: false }), []);
  // A stranger's automatic set still subtracts build.
  assert.deepEqual(automaticCapabilities({ research: true, build: true }), ["research"]);
  assert.deepEqual(automaticCapabilities({ research: false, build: true }), []);
  assert.deepEqual(automaticCapabilities({ research: true, build: false }), ["research"]);
});

test("no grant the node issues for a NON-owner carries build — and the owner's carries it all", () => {
  // Every branch of the wake path that can produce a grant, driven through the
  // real entry point. A future third branch that forgets the rule fails here.
  const strangers = [
    ["an auto-allow agent answering anyone", make({ crossOwnerAsks: "auto-allow" }), msg({ pubkey: TAL })],
    ["an auto-allow agent answering a third party", make({ crossOwnerAsks: "auto-allow" }), msg({ pubkey: OTHER })],
  ];
  for (const [what, { dispatcher }, event] of strangers) {
    const authority = authorityOf(dispatcher.handle(event));
    assert.ok(authority, `${what}: no authority record at all`);
    assert.equal(authority.kind, "grant", `${what}: expected a grant`);
    for (const capability of NEVER_AUTO_CROSS_OWNER) {
      assert.ok(
        !authority.capabilities.includes(capability),
        `${what}: an automatic grant carried "${capability}" for a non-owner`,
      );
    }
  }
  const { dispatcher } = make();
  const owner = authorityOf(dispatcher.handle(msg({ pubkey: OWNER, tags: [["p", SPIKE]] })));
  assert.equal(owner.kind, "grant");
  assert.deepEqual(owner.capabilities, ["research", "build"], "the owner asked; it runs (AC-16 0.7.0)");
  assert.equal(owner.reason, "owner request");
});

test("a non-owner's turn is unchanged: an explicit withhold, not a narrowed grant", () => {
  const { dispatcher } = make();
  const authority = authorityOf(dispatcher.handle(msg({ pubkey: TAL })));
  assert.equal(authority.kind, "withhold");
  assert.deepEqual(authority.capabilities, []);
});

test("the SAME refused call does not ask twice, and a different one still does", () => {
  // A turn that retries a refused write produces a second blocked record, and
  // two prompts for one call would read as hive402 asking twice about the same
  // thing. (Driven with the OWNER as requester: since DD-56 that is the FIX-87
  // edge rather than the ordinary path, and the dedupe must hold there too.)
  // Matching on the SIGNATURE is what keeps this safe: an approval only ever
  // releases the call it named, so a genuinely different call must still get
  // its own prompt.
  const { dispatcher } = make();
  const block = (id, signature) => ({
    id,
    agent: "spike",
    capability: "build",
    detail: `Write ${signature}`,
    signature,
    requester: OWNER,
    at: Date.now(),
  });
  const tokens = (fx) => fx.map((e) => e.content).join(" ").match(/approve (h4-[a-z0-9]+)/g) ?? [];

  const first = dispatcher.handleBlockedAction(block("b1", "Write|site/index.html"));
  assert.equal(tokens(first).length, 1, "the first refusal asks");

  const retry = dispatcher.handleBlockedAction(block("b2", "Write|site/index.html"));
  assert.deepEqual(retry, [], "the identical call, refused again, does not ask again");

  const other = dispatcher.handleBlockedAction(block("b3", "Write|site/about.html"));
  assert.equal(tokens(other).length, 1, "a different call must still get its own prompt");
});

// ── FIX-82: a grant that does not cover the call is a FINAL answer ─────────

test("the gate does not wait out its poll window when the node has already spoken", async () => {
  // Since DD-56 this is the ordinary path for a NON-owner's build attempt on an
  // auto-allow turn: a grant exists, and it does not carry `build`. The node
  // writes one authority per event and never widens it in place, so waiting
  // cannot change the answer — it only puts 2.5 seconds in front of every
  // escalation prompt, on the path AC-5 measures.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-confirm-"));
  writeGrant({ stateDir, agent: "spike", capabilities: ["research"], reason: "owner request" });

  let slept = 0;
  const result = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Write",
      tool_input: { file_path: "site/index.html", content: "x" },
      prompt_id: "p1",
      cwd: "C:/work/spike",
    },
    waitMs: 2500,
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(result.decision, "deny");
  assert.match(result.verdict.reason, /does not cover "build"/);
  assert.equal(slept, 0, "a decided turn must not be waited out");
});

// ── FIX-87: the approval must reach the turn that was woken by it ─────────
//
// FOUND BY RUNNING IT (2026-08-19, fix cycle 11). The owner posted
// `approve h4-1y5v5`, the node published the wake carrying the released grant,
// the grant landed on disk — and the very next `Write` was refused as
// "capabilities are withheld for this turn". The grant file still read
// `boundPromptId: null`: nothing had claimed it. The turn ledger counted a turn
// with NO turn record beside it, so the turn gate ran and found no
// `[Buzz event:]` header in the prompt.
//
// The harness runs `meh=Queue` with steering support: the wake arrived 7
// seconds before the previous turn finished, so it was folded into the running
// turn instead of starting a fresh prompt with its own header block. The owner
// said yes and nothing happened — and the same mechanism is the best
// explanation for cycle 6's F-015, where an owner's own build was refused for
// reasons nobody could reproduce.

test("FIX-87: an approval reaches a turn the runtime could not attribute", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-fix87-"));
  const signature = toolSignature({ toolName: "Write", toolInput: { file_path: "site/index.html" } });
  // Exactly what the node writes when the owner approves: keyed to the wake
  // event, carrying the proposal and the call it named.
  writeGrant({
    stateDir,
    agent: "spike",
    eventId: "wake-event-id",
    capabilities: ["build"],
    reason: "approved by owner (h4-1y5v5)",
    proposalId: "h4-1y5v5",
    signature,
  });
  // …and NO turn record, because the prompt carried no header the turn gate
  // could parse. This is the whole of the live failure.

  const result = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Write",
      tool_input: { file_path: "site/index.html", content: "<h1>hi</h1>" },
      prompt_id: "p-queued",
      cwd: "C:/work/spike",
    },
    waitMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.decision, "allow", "the owner said yes; the turn must be able to act on it");
  assert.equal(result.verdict.proposalId, "h4-1y5v5", "and the audit row names the approval");
});

test("FIX-87: an unattributed turn can only spend the CALL the owner approved", async () => {
  // The safety line, and the reason DD-21's binding was NOT relaxed for the
  // owner. An unattributed turn is exactly where a second person's queued
  // message can be sitting, so a signature-less grant reachable from there
  // would be F-009 with extra steps.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-fix87-bound-"));
  writeGrant({
    stateDir,
    agent: "spike",
    eventId: "wake-event-id",
    capabilities: ["build"],
    reason: "approved by owner (h4-x)",
    proposalId: "h4-x",
    signature: toolSignature({ toolName: "Write", toolInput: { file_path: "site/index.html" } }),
  });

  const other = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Write",
      tool_input: { file_path: "site/somebody-elses-page.html", content: "x" },
      prompt_id: "p-queued",
      cwd: "C:/work/spike",
    },
    waitMs: 0,
    sleep: async () => {},
  });
  assert.equal(other.decision, "deny", "a different call must not spend the owner's approval");
  assert.match(other.verdict.reason, /named a different action/);
});

test("FIX-87: an unattributed turn may NOT claim an ordinary turn grant", async () => {
  // Only approvals are claimable this way. An ordinary per-turn grant belongs
  // to the message that earned it, and letting an unattributable turn inherit
  // one would hand authority to whatever the harness happened to bundle.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-fix87-turn-"));
  writeGrant({
    stateDir,
    agent: "spike",
    eventId: "someone-elses-event",
    capabilities: ["research"],
    reason: "owner request", // no proposalId: nobody approved anything
  });

  const result = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research"],
    input: {
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
      prompt_id: "p-queued",
      cwd: "C:/work/spike",
    },
    waitMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.decision, "deny", "an unattributed turn inherits nothing but an approval");
});

test("FIX-87: one unattributed turn, one claim — a second turn gets nothing", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-fix87-once-"));
  const signature = toolSignature({ toolName: "Write", toolInput: { file_path: "site/index.html" } });
  writeGrant({
    stateDir,
    agent: "spike",
    eventId: "wake-event-id",
    capabilities: ["build"],
    reason: "approved by owner (h4-y)",
    proposalId: "h4-y",
    signature,
  });
  const call = (promptId) =>
    runGate({
      stateDir,
      agent: "spike",
      enabled: ["build"],
      input: {
        tool_name: "Write",
        tool_input: { file_path: "site/index.html", content: "x" },
        prompt_id: promptId,
        cwd: "C:/work/spike",
      },
      waitMs: 0,
      sleep: async () => {},
    });
  assert.equal((await call("p-first")).decision, "allow");
  assert.equal((await call("p-second")).decision, "deny", "the approval is worth one turn");
});

test("FIX-87: a refusal records which approval the turn was running under", async () => {
  // How the node tells "the owner confirmed this build a moment ago and the
  // deploy is part of the same run" from "a fresh turn wants to deploy" — the
  // difference between one confirmation and two, on a turn with no turn record
  // for the node to join through.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-fix87-blocked-"));
  writeGrant({
    stateDir,
    agent: "spike",
    eventId: "wake-event-id",
    capabilities: ["build"],
    reason: "approved by owner (h4-z)",
    proposalId: "h4-z",
    signature: toolSignature({ toolName: "Write", toolInput: { file_path: "site/index.html" } }),
  });
  // Claim it the way the approved Write would.
  await runGate({
    stateDir,
    agent: "spike",
    enabled: ["build"],
    input: {
      tool_name: "Write",
      tool_input: { file_path: "site/index.html", content: "x" },
      prompt_id: "p-run",
      cwd: "C:/work/spike",
    },
    waitMs: 0,
    sleep: async () => {},
  });
  // …then the same turn reaches for run402, which is always refused (DD-27).
  await runGate({
    stateDir,
    agent: "spike",
    enabled: ["build"],
    input: {
      tool_name: "Bash",
      tool_input: { command: "run402 sites deploy-dir ./site" },
      prompt_id: "p-run",
      cwd: "C:/work/spike",
    },
    waitMs: 0,
    sleep: async () => {},
  });

  const blocked = readdirSync(path.join(stateDir, "blocked"))
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(path.join(stateDir, "blocked", n), "utf8")));
  const delegated = blocked.find((b) => b.delegate === "run402");
  assert.ok(delegated, "the deploy refusal must be recorded");
  assert.equal(delegated.proposalId, "h4-z", "and it must name the approval that released this turn");
});

test("but the gate DOES still wait when no record for this turn exists yet", async () => {
  // Unchanged, and it must stay that way: an owner's message reaches the agent
  // directly, so the node's 2s poll may genuinely not have written the record.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-confirm-wait-"));
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p1", eventId: "e-none", now: Date.now() });

  let slept = 0;
  const result = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research"],
    input: {
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
      prompt_id: "p1",
      cwd: "C:/work/spike",
    },
    waitMs: 600,
    pollMs: 200,
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(result.decision, "deny");
  assert.ok(slept > 0, "with no record at all, the node may simply not have spoken yet");
});
