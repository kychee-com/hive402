// F-013: conversation refused because the sentence contained an action verb.
//
// Found by the /validate orchestrator on 2026-08-16 by re-probing the live room
// straight after cycle 4's PASS. Five ordinary messages from the agent's OWN
// OWNER; two of them were refused outright:
//
//   "how do we build trust in a team?"        → @spike cannot do that:
//   "what did you deploy yesterday…?"           capability "build" is disabled
//
// The agent never ran. Nobody asked it to build anything. The words "build" and
// "deploy" are the likeliest words in a room whose entire subject is people
// building software together.
//
// Root cause: `#forAgent` derived an `action` from the message TEXT, and a hit
// went to `evaluateRequest`, which returns `deny` for a disabled capability —
// and the deny branch returned a refusal INSTEAD of a wake. A false positive on
// the text was therefore a refusal to talk.
//
// Neither criterion asks for that. AC-17 is about "an ACTION the agent is not
// capability-enabled for"; AC-12 is about an agent PERFORMING a
// non-conversational action. Talking is neither, so this is a defect, not a
// spec question (DD-26).
//
// ── What this file is careful about ────────────────────────────────────────
//
// Asserting that a classifier returns null would prove nothing: the classifier
// is not what refused, the wake path is. So every test here asserts the thing
// that actually failed live — the agent gets its turn — and the containment
// tests call the REAL `PreToolUse` entry point (`runGate`) against the record
// the node really wrote, rather than a stand-in for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { Supervisor } from "../src/node/supervisor.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";
import { runGate } from "../src/runtime/toolgate.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const spike = (over = {}) => ({
  name: "spike",
  pubkey: SPIKE,
  ownerPubkey: OWNER,
  research: true,
  build: false, // exactly the live rig: build is OFF
  crossOwnerAsks: "owner-approves",
  replyMode: "addressed-only",
  ...over,
});

function make({ agents = [spike()] } = {}) {
  const audit = new AuditLog();
  return {
    audit,
    dispatcher: new Dispatcher({
      nodePubkey: NODE,
      agents,
      turnCap: new TurnCap({ limit: 20 }),
      loopGuard: new LoopGuard(),
      audit,
    }),
  };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });
const wakes = (fx) => fx.filter((e) => e.type === "wake");
const says = (fx) => fx.filter((e) => e.type === "say");
const said = (fx) => says(fx).map((e) => e.content).join(" ");
const authorityOf = (fx) => {
  const standalone = fx.find((e) => e.type === "authority");
  return standalone ?? wakes(fx)[0]?.authority ?? null;
};

// ── The probe set ──────────────────────────────────────────────────────────
//
// The first five are the orchestrator's own probes, verbatim. The rest cover
// the rest of the deleted lexicon, one benign sentence per verb it matched:
// build, deploy, research, search, look up, write code, fix, commit, merge,
// implement, refactor, push. These are the sentences a room full of people
// building software actually says.
const PROBES = [
  "hello, how are you today?",
  "what do you think of the weather?",
  "can you check the fix?",
  "how do we build trust in a team?",
  "what did you deploy yesterday, conceptually?",
  "what's your research process when you get stuck?",
  "how would you search for meaning in a career?",
  "do you prefer to write code first or to think first?",
  "what does it take to fix a broken team culture?",
  "can you look up to someone and still disagree with them?",
  "is a merge conflict a decent metaphor for disagreement?",
  "should we commit to the plan or stay flexible?",
  "what would you implement first with a free week?",
  "when is it worth a refactor of how a team works?",
  "how hard do you push back on a bad idea?",
  "what would happen if we tried to scaffold the whole thing in a day?",
];

test("F-013: every ordinary sentence gets the agent its turn — from the owner", () => {
  // The exact shape that failed live: the owner speaks, the harness delivers it
  // straight to the agent (p-tag), and the node's only job is to state what the
  // turn may do. It must never answer INSTEAD of the agent.
  const refused = [];
  for (const [i, text] of PROBES.entries()) {
    const { dispatcher } = make();
    const effects = dispatcher.handle(
      msg({ id: `owner-${i}`, pubkey: OWNER, content: `@spike ${text}`, tags: [["p", SPIKE]] }),
    );
    if (says(effects).length > 0) refused.push(`${text} → ${said(effects)}`);
    const authority = authorityOf(effects);
    assert.ok(authority, `no authority record for the owner's turn: "${text}"`);
    assert.equal(authority.kind, "grant", `the owner's own turn must carry a grant: "${text}"`);
  }
  assert.deepEqual(refused, [], `the node answered instead of the agent:\n${refused.join("\n")}`);
});

test("F-013: every ordinary sentence gets the agent its turn — from a non-owner", () => {
  // Same sentences from someone who is not the owner. The turn is contained —
  // it carries no capability — but the agent is still woken, because
  // conversation is free for everyone (AC-12, AC-5).
  const refused = [];
  for (const [i, text] of PROBES.entries()) {
    const { dispatcher } = make();
    const effects = dispatcher.handle(msg({ id: `tal-${i}`, pubkey: TAL, content: `@spike ${text}` }));
    if (says(effects).length > 0) refused.push(`${text} → ${said(effects)}`);
    assert.equal(wakes(effects).length, 1, `the agent must be woken for: "${text}"`);
    assert.equal(
      wakes(effects)[0].authority?.kind,
      "withhold",
      `a non-owner's turn must still be contained: "${text}"`,
    );
  }
  assert.deepEqual(refused, [], `the node answered instead of the agent:\n${refused.join("\n")}`);
});

test("F-013: even a real, explicit action request wakes the agent rather than being refused", () => {
  // The lexicon's TRUE positives go the same way as its false ones, and this is
  // the point of DD-26: the node stops trying to tell them apart. "deploy the
  // app" is contained by the grant it does not contain, not by a refusal
  // composed from the wording — and the agent still gets to answer the person.
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: OWNER, content: "@spike deploy the app to production" }));
  assert.equal(says(effects).length, 0, "no pre-emptive refusal");
  assert.equal(wakes(effects).length, 1);
  const authority = wakes(effects)[0].authority;
  assert.equal(authority.kind, "grant");
  assert.deepEqual(
    authority.capabilities,
    ["research"],
    "and the grant must not contain the disabled capability (AC-17 at the boundary that enforces it)",
  );
});

// ── AC-17 still holds, at the layer that can actually enforce it ───────────

test("a disabled capability is refused when the agent REACHES FOR IT, with no approval offered", () => {
  // The refusal did not disappear; it moved to the only place that can tell an
  // action from a sentence. This is what the room now sees in place of the
  // false positive — and only when something was really attempted.
  const { dispatcher } = make({ agents: [spike({ build: false })] });
  const effects = dispatcher.handleBlockedAction({
    id: "b-f013",
    agent: "spike",
    capability: "build",
    detail: "Write C:/app/server.js",
    // Named explicitly since FIX-111 (AC-52, DD-44): a refusal the node cannot
    // attribute to a person is now audit-only, so a record with no requester
    // would test the silent route rather than this one. Its neighbours here
    // always supplied a requester; omitting it was an oversight, and the
    // behaviour under test — an AC-17 refusal naming the SETTING and offering
    // no token — is unchanged.
    requester: TAL,
    at: Date.now(),
  });
  assert.match(said(effects), /switched off/i, `expected an AC-17 refusal, got: ${said(effects)}`);
  assert.doesNotMatch(said(effects), /h4-[a-z0-9]+/, "AC-17: no approval can unlock it, so none is offered");
});

test("a capability that IS enabled becomes the owner's approval request instead", () => {
  // AC-14 by containment: the same path, a different answer, because this one
  // the owner really can unlock.
  const { dispatcher } = make({ agents: [spike({ research: true })] });
  const effects = dispatcher.handleBlockedAction({
    id: "b-research",
    agent: "spike",
    capability: "research",
    detail: "WebFetch https://example.com",
    requester: TAL,
    at: Date.now(),
  });
  assert.match(said(effects), /approve h4-[a-z0-9]+/, `expected an approval request, got: ${said(effects)}`);
  const ask = says(effects).find((s) => /approve h4-/.test(s.content));
  assert.deepEqual(ask.mentions, [OWNER], "the owner is the one who may say yes (AC-67 pairs it with a requester notice)");
});

test('crossOwnerAsks "deny" is enforced where the action is, not only in a sentence', () => {
  // REGRESSION: this setting lived ONLY in the pre-wake decision that F-013's
  // fix deletes. Without moving it, the escalation path would have asked the
  // owner to approve exactly what the owner configured away.
  const { dispatcher } = make({ agents: [spike({ research: true, crossOwnerAsks: "deny" })] });
  const effects = dispatcher.handleBlockedAction({
    id: "b-deny",
    agent: "spike",
    capability: "research",
    detail: "WebFetch https://example.com",
    requester: TAL,
    at: Date.now(),
  });
  assert.doesNotMatch(said(effects), /h4-[a-z0-9]+/, "no approval token for an agent that takes no cross-owner asks");
  assert.match(said(effects), /does not take requests from others/i, `got: ${said(effects)}`);
});

test('crossOwnerAsks "deny" still lets the OWNER be asked about their own request', () => {
  const { dispatcher } = make({ agents: [spike({ research: true, crossOwnerAsks: "deny" })] });
  const effects = dispatcher.handleBlockedAction({
    id: "b-deny-owner",
    agent: "spike",
    capability: "research",
    detail: "WebFetch https://example.com",
    requester: OWNER,
    at: Date.now(),
  });
  assert.match(said(effects), /approve h4-[a-z0-9]+/, `the owner's own request is not a cross-owner ask: ${said(effects)}`);
});

// ── The same class, two more text patterns that swallowed a message ───────

test("a chat command is answered only when the message IS that command", () => {
  const { dispatcher } = make();
  const bare = dispatcher.handle(msg({ id: "c1", pubkey: OWNER, content: "@spike /audit" }));
  assert.equal(wakes(bare).length, 0, "a log query must not cost a model turn");
  assert.match(said(bare), /no audit entries|·/i);
});

test("a sentence that merely MENTIONS /audit reaches the agent", () => {
  // REGRESSION: the command matcher was an unanchored search, so an ordinary
  // sentence about the audit endpoint was answered by the node and the agent
  // never saw it. Same defect class as F-013, one pattern over.
  const { dispatcher } = make();
  for (const text of [
    "@spike what do you think of the /audit endpoint we built?",
    "@spike is /help the right name for that page?",
    "@spike how many /turns does a good conversation take?",
  ]) {
    const effects = dispatcher.handle(msg({ id: text, pubkey: OWNER, content: text }));
    assert.equal(says(effects).length, 0, `the node answered a conversation: ${text} → ${said(effects)}`);
    assert.equal(wakes(effects).length, 1, `the agent must be woken for: ${text}`);
  }
});

test("an approval naming a token nobody is holding is just conversation", () => {
  // REGRESSION: `#handleApproval` returned an empty effect list for an unknown
  // or already-spent token, and an empty list is still "handled" — so the
  // message was dropped: no wake, no reply, no notice. Silence is the worst
  // possible answer, because the room cannot tell it from a broken agent.
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ id: "a1", pubkey: OWNER, content: "@spike I'd approve h4-nothing in principle — what do you think?" }),
  );
  assert.equal(wakes(effects).length, 1, "an unmatched approval must not swallow the message");
});

test("a real pending approval is still consumed as an approval, not as chatter", () => {
  const { dispatcher } = make();
  const ask = dispatcher.handleBlockedAction({
    id: "b-token",
    agent: "spike",
    capability: "research",
    detail: "WebFetch https://example.com",
    requester: TAL,
    at: Date.now(),
  });
  const token = said(ask).match(/approve (h4-[a-z0-9]+)/)[1];
  const effects = dispatcher.handle(msg({ id: "a2", pubkey: OWNER, content: `approve ${token}` }));
  assert.equal(wakes(effects).length, 1, "approving releases the parked turn");
  assert.equal(wakes(effects)[0].authority.kind, "grant");
});

// ── End to end: the node's record, then the REAL runtime gate ─────────────
//
// The two halves of this fix have to be true at the same time, and a test that
// only exercised the dispatcher could not show that: the agent must be able to
// TALK on the very turn a "build" sentence produced, and a real build tool on
// that same turn must still be refused. So this drives the actual supervisor,
// takes the record it really wrote to disk, and hands it to the actual
// `PreToolUse` entry point.

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: SPIKE });

const config = () => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:/Buzz", nodeDir: "C:/node", adapter: "C:/adapter.js", extraDirs: [] },
  rooms: [{ channel: CHANNEL, agents: [{ ...spike(), privateKeyRef: "env:TEST_AGENT_KEY", selfInitiated: "asks-owner" }] }],
});

function harness() {
  const events = [];
  const sent = [];
  const cli = {
    deliver: (e) => events.push(e),
    async getMessages() { return events; },
    async send(args) {
      const event_id = `sent-${sent.length + 1}`.padEnd(64, "0");
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    async setProfile() { return { accepted: true }; },
    async getUser({ pubkey }) { return pubkey === SPIKE ? { pubkey: SPIKE, display_name: "spike" } : null; },
  };
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f013-"));
  const sup = new Supervisor({
    config: config(),
    stateDir,
    spawn: () => ({ pid: 4242, killed: false, kill() { this.killed = true; } }),
    makeCli: () => cli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
  });
  return { sup, cli, sent, stateDir, workDir: path.join(stateDir, "work", "spike") };
}

const nowait = { sleep: async () => {}, waitMs: 0 };

test("a benign 'build' sentence: the agent gets its turn, can speak, and still cannot build", async () => {
  const { sup, cli, sent, stateDir, workDir } = harness();
  await sup.start();

  cli.deliver(
    msg({
      id: "e-build-trust",
      pubkey: OWNER,
      content: "@spike how do we build trust in a team?",
      tags: [["p", SPIKE]],
    }),
  );
  await sup.tick();

  // 1. Nothing was posted at the agent instead of an answer from it.
  assert.deepEqual(
    sent.filter((s) => /cannot do that/i.test(s.content)).map((s) => s.content),
    [],
    "the node must not refuse a conversation",
  );

  // 2. The turn exists, and its grant is honest about the disabled capability.
  const authority = readAuthority({ stateDir, agent: "spike", eventId: "e-build-trust" });
  assert.equal(authority.kind, "grant");
  assert.deepEqual(authority.capabilities, ["research"]);

  // 3. The REAL gate, on that real record: the agent's voice goes through.
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-trust", eventId: "e-build-trust", now: Date.now() });
  const speech = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research"],
    input: {
      tool_name: "Bash",
      tool_input: { command: `buzz messages send --channel ${CHANNEL} --content "Trust is built by keeping small promises."` },
      prompt_id: "p-trust",
      cwd: workDir,
    },
    ...nowait,
  });
  assert.equal(speech.decision, "allow", "the agent must be able to reply on this turn");

  // 4. And the same turn cannot build anything, by either route.
  for (const input of [
    { tool_name: "Write", tool_input: { file_path: "C:/app/server.js", content: "x" } },
    { tool_name: "Bash", tool_input: { command: "npm run build" } },
  ]) {
    const verdict = await runGate({
      stateDir,
      agent: "spike",
      enabled: ["research"],
      input: { ...input, prompt_id: "p-trust", cwd: workDir },
      ...nowait,
    });
    assert.equal(verdict.decision, "deny", `${input.tool_name} must still be refused`);
    assert.equal(verdict.verdict.capability, "build");
    assert.match(
      verdict.output.hookSpecificOutput.permissionDecisionReason,
      /disabled for this agent by its owner/i,
      "and the agent must be told it is a setting, not a missing approval",
    );
  }

  // 5. The refusal left the record the node turns into the room's AC-17 answer.
  const blocked = readdirSync(path.join(stateDir, "blocked")).filter((f) => f.endsWith(".json"));
  assert.equal(blocked.length, 2, "every refused call leaves a blocked record for the node to report");
});

test("the room learns about the refusal, and is told it is a setting rather than a missing approval", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  cli.deliver(msg({ id: "e-deploy", pubkey: OWNER, content: "@spike deploy the todo app", tags: [["p", SPIKE]] }));
  await sup.tick();
  sent.length = 0;

  // What the runtime gate really writes when it refuses (shape asserted by the
  // end-to-end test above).
  const dir = path.join(stateDir, "blocked");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "b-deploy.json"),
    JSON.stringify({
      id: "b-deploy",
      agent: "spike",
      capability: "build",
      detail: "Bash: npm run deploy",
      promptId: "p-deploy",
      at: Date.now(),
    }),
    "utf8",
  );
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-deploy", eventId: "e-deploy", now: Date.now() });
  await sup.tick();

  const refusal = sent.find((s) => /cannot do that/i.test(s.content));
  assert.ok(refusal, `the room must be told: ${JSON.stringify(sent.map((s) => s.content))}`);
  assert.match(refusal.content, /switched off/i);
  assert.doesNotMatch(refusal.content, /h4-[a-z0-9]+/);

  // And it is in the audit log, which is what `@spike /audit` reads.
  const audited = sup.audit.query({ agent: "spike" }).some((r) => /contained/.test(r.detail ?? ""));
  assert.ok(audited, "a contained action must be recorded (AC-27)");
});

test("no source file classifies request text any more", () => {
  // The failure mode this product has shipped twice is a mechanism with no
  // caller under a green suite (`LoopGuard.allow()`, an invented attestation
  // format). A lexicon left on disk is a lexicon somebody wires back in, so the
  // whole of `src` is checked, not just the module that used to call it.
  // An import of either deleted module, or a CALL of either function. Prose
  // about why they are gone is not a violation — wiring them back in is.
  const WIRED_IN = /from\s+["'][^"']*gate\/(?:intent|actions)|(?:classifyIntent|evaluateRequest)\s*\(/;
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs") && WIRED_IN.test(readFileSync(full, "utf8"))) {
        offenders.push(path.relative(src, full));
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], `text classification is back in: ${offenders.join(", ")}`);
});
