// F-009 (cycle 3, P0) — the regression test for the race itself.
//
// What the Red Team did: sent two messages to one agent 40 milliseconds apart.
// First Barry (the agent's real owner) asking it to fetch an ETH/USD price;
// then tal, who owns nothing here, asking it for the top post on lobste.rs.
//
// What happened: both landed in the same node poll. The node wrote Barry's
// grant and then tal's withhold into the SAME per-agent slot, so Barry's own
// turn found "withheld" and was denied. The node then attributed that denial to
// tal (its "last trigger" slot had also been overwritten), asked Barry to
// approve it, and named Barry's own ETH/USD fetch in the prompt. Barry
// approved. The grant that approval issued said only "spike may research now" —
// so the next research call to reach the gate consumed it, and that call was
// tal's lobste.rs fetch. A non-owner got real live data on an approval the
// owner believed was for something else, and Barry's own request was never
// fulfilled at all.
//
// Three separate defects, so three separate properties are asserted here:
//   1. two authorities in flight must not overwrite each other  (DD-20)
//   2. a turn may only use the authority for ITS OWN trigger    (DD-19 + DD-20)
//   3. an approval may only release the call it named           (DD-21, FIX-26)
//
// (3) lives in test/approval-binding.test.mjs. This file covers (1) and (2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGate } from "../src/runtime/toolgate.mjs";
import { writeGrant, writeWithheld } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";

const state = () => mkdtempSync(path.join(tmpdir(), "hive402-f009-"));
const now = 1_700_000_000_000;
const nowait = { sleep: async () => {}, waitMs: 0 };

// The two events, as they really are: the owner's own message reaches the agent
// directly, and the non-owner's is dropped by the harness and republished by
// the node — so the second trigger is the NODE's wake event, not tal's message.
const OWNER_EVENT = "a".repeat(64);
const WAKE_EVENT = "b".repeat(64);
const ETH = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const LOBSTERS = "https://lobste.rs/";

const fetchCall = (url, promptId) => ({
  tool_name: "WebFetch",
  tool_input: { url },
  prompt_id: promptId,
});

// The node's side of the race: an owner grant, then 40ms later a withhold for
// somebody else's turn.
function raceTheNode(dir, { ownerFirst = true } = {}) {
  const owner = () =>
    writeGrant({
      stateDir: dir, agent: "spike", eventId: OWNER_EVENT,
      capabilities: ["research"], reason: "owner request", now,
    });
  const other = () =>
    writeWithheld({
      stateDir: dir, agent: "spike", eventId: WAKE_EVENT,
      reason: "turn triggered by dab7655a…, who is not spike's owner", now: now + 40,
    });
  if (ownerFirst) { owner(); other(); } else { other(); owner(); }

  // The runtime's own report of what each turn is (turngate.mjs).
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "turn-owner", eventId: OWNER_EVENT, now });
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "turn-other", eventId: WAKE_EVENT, now: now + 40 });
}

test("F-009: the owner's own request survives a non-owner landing 40ms later", async () => {
  const dir = state();
  raceTheNode(dir);

  const owner = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(ETH, "turn-owner"),
  });
  assert.equal(owner.decision, "allow", "AC-16: the owner's direct request must not need an approval round trip");
});

test("F-009: the non-owner's turn cannot use the authority the owner was given", async () => {
  const dir = state();
  raceTheNode(dir);

  const other = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now: now + 40, ...nowait,
    input: fetchCall(LOBSTERS, "turn-other"),
  });
  assert.equal(other.decision, "deny", "AC-14: a non-owner's turn holds no capability");
});

test("F-009: the race is symmetric — the non-owner arriving FIRST changes nothing", async () => {
  const dir = state();
  raceTheNode(dir, { ownerFirst: false });

  const owner = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(ETH, "turn-owner"),
  });
  const other = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now: now + 40, ...nowait,
    input: fetchCall(LOBSTERS, "turn-other"),
  });
  assert.equal(owner.decision, "allow");
  assert.equal(other.decision, "deny");
});

test("F-009: the owner's own turn, having acted, does not leave authority lying around", async () => {
  // The original leak needed an unclaimed grant to be sitting there when the
  // next turn reached for a tool. Once the owner's turn has claimed it, a
  // different turn presenting the same event is refused too.
  const dir = state();
  raceTheNode(dir);

  await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(ETH, "turn-owner"),
  });

  // A second turn that somehow claims the owner's trigger event.
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "turn-thief", eventId: OWNER_EVENT, now: now + 50 });
  const thief = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now: now + 50, ...nowait,
    input: fetchCall(LOBSTERS, "turn-thief"),
  });
  assert.equal(thief.decision, "deny", "an authority is worth exactly one turn");
});

test("F-009: a turn whose trigger has no authority record is refused, not waved through", async () => {
  const dir = state();
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "turn-ghost", eventId: "f".repeat(64), now });

  const result = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(LOBSTERS, "turn-ghost"),
  });
  assert.equal(result.decision, "deny");
});

test("F-009: conversation still runs on a withheld turn — containment must not mute", async () => {
  // The failure mode this whole cycle is guarding against in the other
  // direction. A contained turn keeps its voice (AC-12).
  const dir = state();
  raceTheNode(dir);

  const speech = await runGate({
    stateDir: dir, agent: "spike", now: now + 40, ...nowait,
    input: {
      tool_name: "Bash",
      tool_input: { command: "buzz messages send --channel abc --content 'I was refused, and here is why.'" },
      prompt_id: "turn-other",
    },
  });
  assert.equal(speech.decision, "allow");
});

test("with no turn record at all, the legacy per-agent record still decides", async () => {
  // If the turn gate does not fire on some future runtime, the gate degrades to
  // cycle-2 behaviour rather than to a mute agent. DD-21's proposal binding is
  // what holds the security line in that case, not this.
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], reason: "owner request", now });

  const result = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(ETH, "turn-legacy"),
  });
  assert.equal(result.decision, "allow");
});
