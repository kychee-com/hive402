// Collecting the promises made for OUR agents while this node was off
// (F-11: AC-63, AC-64, AC-65 — the pure half).
//
// A promise is a taken-message notice authored by a TRUSTED node (the
// registry's authors, or this node itself), naming one of our agents, whose
// reply marker pins the promised message. Replay is bounded by count, never
// by age; a thread already answered by the agent is complete; one already
// answered by a human still gets a brief acknowledgment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { awayNotice } from "../src/listener/notices.mjs";
import {
  addressesAgent,
  capPromises,
  isDispatched,
  markDispatched,
  promisesIn,
  threadVerdict,
} from "../src/node/promises.mjs";
import { COVER_DEFAULTS, parseConfig } from "../src/config/schema.mjs";

const A = (n) => n.repeat(64);
const SPIKE = { name: "spike", pubkey: A("a") };
const TALNODE = A("b");
const SELF = A("9");
const TAL = A("7");

const notice = ({ id = A("2"), target = A("3"), author = TALNODE, name = "spike", at = 100 } = {}) => ({
  id,
  kind: 9,
  pubkey: author,
  created_at: at,
  content: awayNotice({ name }),
  tags: [["e", target, "", "reply"]],
});

test("promisesIn finds trusted notices naming our agents, keyed by (message, agent)", () => {
  const promises = promisesIn({
    events: [notice()],
    agents: [SPIKE],
    trustedAuthors: [TALNODE, SELF],
  });
  assert.equal(promises.length, 1);
  assert.equal(promises[0].id, A("3"));
  assert.equal(promises[0].agent.name, "spike");
});

test("promisesIn drops what it must not trust or cannot use", () => {
  const promises = promisesIn({
    events: [
      notice(),
      notice({ id: A("4"), author: A("c") }), // untrusted author — forgeable
      notice({ id: A("5"), name: "stranger" }), // not our agent
      { ...notice({ id: A("6") }), tags: [] }, // pins nothing
      { ...notice({ id: A("7") }), content: "[hive402] spike cannot answer right now. x" },
      notice({ id: A("8"), target: A("3") }), // duplicate promise, same key
    ],
    agents: [SPIKE],
    trustedAuthors: [TALNODE],
  });
  assert.equal(promises.length, 1);
});

test("addressesAgent guards a notice against pointing at a message that never asked", () => {
  assert.ok(
    addressesAgent({
      event: { kind: 9, pubkey: TAL, content: "@spike ping", tags: [] },
      agent: SPIKE,
    }),
  );
  assert.ok(
    !addressesAgent({
      event: { kind: 9, pubkey: TAL, content: "no agent here", tags: [] },
      agent: SPIKE,
    }),
  );
});

test("threadVerdict tells an agent's answer from a human's from machine chatter", () => {
  const machineAuthors = [TALNODE, SELF];
  const reply = (author, content = "text", at = 200) => ({
    kind: 9, pubkey: author, created_at: at, content, tags: [],
  });

  assert.deepEqual(
    threadVerdict({ replies: [reply(SPIKE.pubkey)], agentPubkey: SPIKE.pubkey, machineAuthors, afterSec: 100 }),
    { answeredByAgent: true, answeredByHuman: false },
  );
  assert.deepEqual(
    threadVerdict({ replies: [reply(TAL)], agentPubkey: SPIKE.pubkey, machineAuthors, afterSec: 100 }),
    { answeredByAgent: false, answeredByHuman: true },
  );
  // A node's notice in the thread is neither — and neither is anything that
  // predates the promised message.
  assert.deepEqual(
    threadVerdict({
      replies: [reply(TALNODE, awayNotice({ name: "spike" })), reply(TAL, "earlier", 50)],
      agentPubkey: SPIKE.pubkey,
      machineAuthors,
      afterSec: 100,
    }),
    { answeredByAgent: false, answeredByHuman: false },
  );
});

test("capPromises keeps the NEWEST per agent and replays oldest-first, naming the dropped", () => {
  const joined = [1000, 2000, 3000].map((at, i) => ({
    original: { id: A(String(i + 1)), created_at: at },
    agent: SPIKE,
  }));
  const { kept, dropped } = capPromises({ promises: joined, cap: 2 });
  assert.deepEqual(
    kept.map((p) => p.original.created_at),
    [2000, 3000],
    "the newest two, replayed oldest-first",
  );
  assert.deepEqual([...dropped.entries()], [["spike", 1]]);
});

test("capPromises under the cap drops nothing", () => {
  const joined = [{ original: { id: A("1"), created_at: 1 }, agent: SPIKE }];
  const { kept, dropped } = capPromises({ promises: joined, cap: 10 });
  assert.equal(kept.length, 1);
  assert.equal(dropped.size, 0);
});

test("dispatched marks survive a restart and prune with age", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-marks-"));
  assert.ok(!isDispatched({ stateDir, id: A("3"), agent: "spike" }));
  markDispatched({ stateDir, id: A("3"), agent: "spike", at: 1000 });
  assert.ok(isDispatched({ stateDir, id: A("3"), agent: "spike" }));
  assert.ok(!isDispatched({ stateDir, id: A("3"), agent: "other" }), "per agent, not per message");

  // A mark far older than the horizon is pruned by the next write.
  markDispatched({ stateDir, id: A("4"), agent: "spike", at: 1000 + 40 * 24 * 60 * 60 });
  assert.ok(!isDispatched({ stateDir, id: A("3"), agent: "spike" }), "the ancient mark is gone");
  assert.ok(isDispatched({ stateDir, id: A("4"), agent: "spike" }));
});

test("the replay cap is configurable and validated, defaulting to 10", () => {
  assert.equal(COVER_DEFAULTS.replayCapPerAgent, 10);
  const base = {
    relayUrl: "ws://x",
    node: { pubkey: A("9"), privateKeyRef: "keychain" },
    rooms: [{ channel: "c", agents: [{ name: "spike", pubkey: A("a"), ownerPubkey: A("8") }] }],
  };
  assert.equal(parseConfig(base).cover.replayCapPerAgent, 10);
  assert.equal(parseConfig({ ...base, cover: { replayCapPerAgent: 3 } }).cover.replayCapPerAgent, 3);
  assert.throws(() => parseConfig({ ...base, cover: { replayCapPerAgent: 0 } }), /replayCapPerAgent/);
});
