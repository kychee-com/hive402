// A refusal nobody asked for stays out of the room (AC-52, F-034, FIX-169, DD-68).
//
// ── The criterion, and the question the router was asking instead ──────────
//
// AC-52: "When an agent's OWN unprompted action is refused by the capability
// gate… it is never published to the channel."
//
// The guard FIX-111 put in `dispatch.mjs` reads:
//
//     if (!this.#isHumanRequester(requester)) return [];
//
// …and `requester` falls back to `#lastTrigger.get(agent.name)` — the last
// human who woke this agent. So the guard asks "was a human behind this TURN?"
// and the criterion asks "did a human ask for this ACTION?". Those are the same
// question only when an agent does nothing of its own accord mid-turn.
//
// T-059 is the case where they differ: a human asked spike2 a question, spike2
// spontaneously reached for its own agent-memory note while answering, the gate
// correctly refused it, and the whole room was told which capability its owner
// had switched off — carrying `record.detail`, the actual call the gate
// refused. DD-44 is not wrong. It is turn-scoped, and AC-52 is action-scoped.
//
// ── Why this is built at the seam, and said out loud ───────────────────────
//
// A model spontaneously choosing to write a memory note is probabilistic. Cycle
// 17 made three genuine attempts to retrigger it and could not, which is honest
// evidence about the trigger and no evidence at all about the router. So the
// dispatcher's real blocked-action path is driven with a real human trigger
// attributed through `#lastTrigger` — the exact fallback that produced T-059 —
// and the assertion is on what reaches the room.
//
// ── The three negative controls are the point of this file ─────────────────
//
// "Nothing was published" is also what a mute produces. A fix that silences
// every refusal would pass the first test in this file and would be a serious
// regression of AC-17. So an ordinary human-asked build refusal, a
// cross-owner-deny refusal and a run402 deploy proposal must all still speak,
// through the SAME trigger and the SAME dispatcher. Those three are what tell
// the fix apart from the mute, and the discrimination pass turns on them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";
import { runGate } from "../src/runtime/toolgate.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

const spike = (over = {}) => ({
  name: "spike",
  pubkey: SPIKE,
  ownerPubkey: OWNER,
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  replyMode: "addressed-only",
  ...over,
});

function make({ agents = [spike()], ...rest } = {}) {
  const audit = new AuditLog();
  return {
    audit,
    dispatcher: new Dispatcher({
      nodePubkey: NODE,
      agents,
      turnCap: new TurnCap({ limit: 20 }),
      loopGuard: new LoopGuard(),
      audit,
      ...rest,
    }),
  };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });
const says = (fx) => fx.filter((e) => e.type === "say");
const said = (fx) => says(fx).map((e) => e.content).join(" ");

// The T-059 shape exactly: NO `triggerEvent` and NO `requester` on the record,
// so the router falls back to `#lastTrigger` — the last human who woke this
// agent. That fallback is the whole defect, so every test here goes through it.
const wokenBy = (dispatcher, pubkey = TAL) =>
  dispatcher.handle(msg({ pubkey, content: "@spike what did we decide about the deploy?" }));

// A refusal of the agent's own memory write, mid-turn. Nobody asked for it and
// nobody in the room could have.
const memoryWrite = (over = {}) => ({
  id: "b-self",
  agent: "spike",
  capability: "build",
  detail: "Write C:/hive402/work/spike/CLAUDE.md",
  signature: "Write|C:/hive402/work/spike/CLAUDE.md",
  selfInitiated: true,
  at: 1,
  ...over,
});

// ── The router: an action nobody asked for is not announced ────────────────

test("F-034: a self-initiated refusal reaches the room not at all", () => {
  const { dispatcher } = make();
  wokenBy(dispatcher);
  const effects = dispatcher.handleBlockedAction(memoryWrite());
  assert.deepEqual(
    says(effects),
    [],
    `AC-52: nothing is published. The room received: ${JSON.stringify(said(effects))}`,
  );
});

test("F-034: …and the room is not told which capability the owner switched off", () => {
  // The T-059 sentence, verbatim in shape. This is the one that made the finding
  // a P2 rather than a nit: the published line named the capability AND carried
  // `record.detail`, the actual call the gate refused.
  const { dispatcher } = make({ agents: [spike({ build: false })] });
  wokenBy(dispatcher);
  const effects = dispatcher.handleBlockedAction(memoryWrite());
  assert.doesNotMatch(said(effects), /switched\s+off/, "no capability state is disclosed");
  assert.doesNotMatch(said(effects), /CLAUDE\.md/i, "and no refused call is published");
});

test("F-034: the audit row is still written — this is a route, not a mute", () => {
  // AC-52 permits the refusal to be "AT MOST, raised with its owner", and
  // audit-only is what raising it amounts to today: there is no DM path, `#say`
  // is the channel, and the channel is exactly what AC-52 forbids here. So the
  // row is what makes audit-only compliant rather than silent, and without this
  // assertion the fix and a mute are the same commit.
  const { audit, dispatcher } = make();
  wokenBy(dispatcher);
  dispatcher.handleBlockedAction(memoryWrite());
  const rows = audit.query({ agent: "spike" });
  assert.ok(
    rows.some((r) => /contained/i.test(`${r.detail ?? ""}`)),
    `the owner must still be able to read this in /audit, got: ${JSON.stringify(rows)}`,
  );
});

// ── The gate: where the mark comes from ────────────────────────────────────
//
// The router can only route on a fact somebody recorded. These drive the REAL
// gate and read the record it wrote to disk, because a test that constructed
// the record itself would prove only that the test can set a boolean.

const WORKDIR = "C:/hive402/work/spike";
const now = 1_700_000_000_000;

const gate = async (toolName, toolInput, over = {}) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f034-"));
  const result = await runGate({
    stateDir,
    agent: "spike",
    enabled: ["research"],
    input: { tool_name: toolName, tool_input: toolInput, prompt_id: "p1", cwd: WORKDIR },
    now,
    waitMs: 0,
    sleep: async () => {},
    ...over,
  });
  const dir = path.join(stateDir, "blocked");
  const files = readdirSync(dir);
  assert.equal(files.length, 1, "the gate must have written exactly one blocked record");
  return { result, record: JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")) };
};

// ── The three negative controls ────────────────────────────────────────────
//
// Each drives the REAL gate for the record and the REAL dispatcher for the
// routing, with no field written by hand in between.
//
// The first cut of these hand-built their records, and that made them useless
// for the mutation that matters most: "mark everything self-initiated" is the
// shape of a fix that silences the room wholesale, and a hand-built record
// carrying no mark cannot notice it. Going through the gate is what turns these
// from three assertions into the three that tell this fix apart from a mute.

test("NEGATIVE CONTROL 1 (AC-17): a human-asked build refusal still speaks", async () => {
  // Same dispatcher, same trigger, same fallback attribution as the silenced
  // case. The ONLY difference is that this action is one a member of the room
  // can ask for, and can get by asking the owner.
  const { record } = await gate("Write", { file_path: `${WORKDIR}/site/index.html`, content: "<h1>hi</h1>" });
  const { dispatcher } = make({ agents: [spike({ build: false })] });
  wokenBy(dispatcher);
  const effects = dispatcher.handleBlockedAction(record);
  assert.ok(says(effects).length > 0, "AC-17 requires the room to be told");
  assert.match(said(effects), /switched off/, "and told which kind of no this is");
});

test("NEGATIVE CONTROL 2: a cross-owner-deny refusal still speaks", async () => {
  const { record } = await gate(
    "WebFetch",
    { url: "https://news.ycombinator.com/" },
    { enabled: ["build"] },
  );
  const { dispatcher } = make({ agents: [spike({ crossOwnerAsks: "deny", research: true })] });
  wokenBy(dispatcher, TAL);
  const effects = dispatcher.handleBlockedAction(record);
  assert.ok(says(effects).length > 0, "the asker must learn their request went nowhere");
  assert.match(said(effects), /does not take requests from/);
});

test("NEGATIVE CONTROL 3: a run402 deploy proposal still speaks", async () => {
  const { record } = await gate("Bash", { command: "run402 deploy ./site" }, { enabled: ["build"] });
  assert.equal(record.delegate, "run402", "the gate marked it as the node's job (DD-27)");
  const { dispatcher } = make({ agents: [spike({ build: true })] });
  wokenBy(dispatcher);
  const effects = dispatcher.handleBlockedAction(record);
  assert.ok(says(effects).length > 0, "DD-27's delegation is announced, not swallowed");
});

test("FIX-169: a refused write to the agent's own memory file is marked self-initiated", async () => {
  const { record } = await gate("Write", { file_path: `${WORKDIR}/CLAUDE.md`, content: "notes" });
  assert.equal(record.selfInitiated, true, "AC-54: no member of this room can ask for a private note");
});

test("FIX-169: …by the bare name too, which is how a model actually writes it", async () => {
  const { record } = await gate("Write", { file_path: "CLAUDE.md", content: "notes" });
  assert.equal(record.selfInitiated, true);
});

test("FIX-169: …and by shell redirect, the spelling the harness rules cannot see", async () => {
  const { record } = await gate("Bash", { command: `echo "learned a thing" >> ${WORKDIR}/CLAUDE.md` });
  assert.equal(record.selfInitiated, true);
});

test("FIX-169: a refused write to a GOVERNED file is marked self-initiated", async () => {
  // AC-55: the files that define the agent. `verdict.governed` has been computed
  // at the gate since DD-56 and was simply never persisted onto the record —
  // half this change is carrying a fact the gate already had.
  const { record } = await gate("Write", { file_path: "C:/Users/barry/.hive402/config.json", content: "{}" });
  assert.equal(record.governed, true, "the gate's own verdict reaches the record");
  assert.equal(record.selfInitiated, true);
});

test("FIX-169: an ordinary refused build is NOT marked self-initiated", () => {
  // The gate-side negative control. Without it, "mark everything" passes every
  // assertion above.
  return gate("Write", { file_path: `${WORKDIR}/site/index.html`, content: "<h1>hi</h1>" }).then(
    ({ record }) => {
      assert.notEqual(record.selfInitiated, true, "a human can and does ask for this");
    },
  );
});

test("FIX-169: a refused research fetch is NOT marked self-initiated", async () => {
  const { record } = await gate("WebFetch", { url: "https://news.ycombinator.com/" }, { enabled: ["build"] });
  assert.notEqual(record.selfInitiated, true);
});

// ── The end-to-end join ────────────────────────────────────────────────────

test("FIX-169: the gate's mark is what silences the room, end to end", async () => {
  // Both halves in one test, with nothing hand-written between them: the gate
  // decides, the record carries it, the router reads it. If either half stops
  // working this fails, and it fails for a reason the other tests name.
  const { record } = await gate("Write", { file_path: `${WORKDIR}/CLAUDE.md`, content: "notes" });
  const { dispatcher } = make();
  wokenBy(dispatcher);
  const effects = dispatcher.handleBlockedAction(record);
  assert.deepEqual(says(effects), [], "the record the GATE wrote is the one the router silences");
});

// ── The house rules half (F-034's second piece of evidence) ────────────────

test("FIX-169: the agent is told not to announce its own capability state", async () => {
  // Cycle 17 also watched spike2 tell the room, unprompted, that it was
  // "read-and-reply only". That is agent speech, not a node notice, so no
  // router can reach it — the house rules are the only lever this product has.
  // The test asserts the sentence is in the composed prompt. The BEHAVIOUR is
  // probabilistic and is FIX-173's to observe, not this file's to guarantee.
  const { HOUSE_ETIQUETTE } = await import("../src/launcher/instructions.mjs");
  const flat = HOUSE_ETIQUETTE.toLowerCase().replace(/\s+/g, " ");
  assert.match(flat, /capabilit|settings/, "the subject is named");
  assert.match(flat, /do not announce|do not tell the room|never announce/, "and the duty is stated");
});
