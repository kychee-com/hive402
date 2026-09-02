// Knowing WHO is a registered agent, and WHOSE node must be reachable for it
// (F-11, DD-53). The managed-agent record (kind 30177) is world-readable and
// keyed d = agent pubkey with the attesting owner as its author — for a
// hive402 agent that author IS the hosting node (DD-51). The cover path
// resolves a room mention against those records, for agents this node does
// NOT host, and keys everything downstream on the record's author.

import { test } from "node:test";
import assert from "node:assert/strict";

import { foreignAgentsIn, foreignMentions, managedAgentsFrom } from "../src/listener/foreign.mjs";

const A = (n) => n.repeat(64); // 64-char pseudo-pubkeys from one hex char

const record = ({ agent, author, name, created_at = 100, kind = 30177 }) => ({
  kind,
  pubkey: author,
  created_at,
  tags: [["d", agent]],
  content: JSON.stringify({ name, parallelism: 1, respond_to: "anyone" }),
});

test("managedAgentsFrom parses agent pubkey, name, and owning author", () => {
  const rows = [record({ agent: A("a"), author: A("b"), name: "smith" })];
  assert.deepEqual(managedAgentsFrom(rows), [{ pubkey: A("a"), name: "smith", node: A("b") }]);
});

test("managedAgentsFrom drops what it cannot trust", () => {
  const rows = [
    record({ agent: A("a"), author: A("b"), name: "ok" }),
    { ...record({ agent: A("c"), author: A("b"), name: "wrongkind" }), kind: 9 },
    { kind: 30177, pubkey: A("b"), created_at: 1, tags: [], content: "{}" }, // no d tag
    { kind: 30177, pubkey: A("b"), created_at: 1, tags: [["d", "short"]], content: "{}" }, // bad d
    { kind: 30177, pubkey: A("b"), created_at: 1, tags: [["d", A("e")]], content: "not json" },
    { kind: 30177, pubkey: A("b"), created_at: 1, tags: [["d", A("f")]], content: "{}" }, // no name
  ];
  assert.deepEqual(managedAgentsFrom(rows), [{ pubkey: A("a"), name: "ok", node: A("b") }]);
});

test("two authors claiming one agent is ambiguity, and ambiguity is dropped", () => {
  // A record's trust rule upstream is "author must be the verified owner", and
  // the node does not re-verify NIP-OA here. Two live claims for one agent
  // therefore mean somebody is wrong — and a notice keyed on the wrong owner's
  // presence would promise an answer the real owner never sees. No notice
  // beats a wrong one.
  const rows = [
    record({ agent: A("a"), author: A("b"), name: "smith" }),
    record({ agent: A("a"), author: A("c"), name: "smith" }),
  ];
  assert.deepEqual(managedAgentsFrom(rows), []);
});

test("the newest record per (author, agent) coordinate wins", () => {
  const rows = [
    record({ agent: A("a"), author: A("b"), name: "old", created_at: 50 }),
    record({ agent: A("a"), author: A("b"), name: "new", created_at: 90 }),
  ];
  assert.deepEqual(managedAgentsFrom(rows), [{ pubkey: A("a"), name: "new", node: A("b") }]);
});

test("case is normalised: mixed-case keys resolve to one agent", () => {
  const rows = [record({ agent: A("a").toUpperCase(), author: A("b").toUpperCase(), name: "smith" })];
  assert.deepEqual(managedAgentsFrom(rows), [{ pubkey: A("a"), name: "smith", node: A("b") }]);
});

test("foreignAgentsIn keeps channel members hosted elsewhere and drops our own", () => {
  const records = [
    { pubkey: A("a"), name: "smith", node: A("b") }, // foreign, in channel
    { pubkey: A("c"), name: "spike", node: A("d") }, // our own agent
    { pubkey: A("e"), name: "ghost", node: A("f") }, // not a channel member
    { pubkey: A("1"), name: "ours2", node: A("9") }, // authored by OUR node
  ];
  const foreign = foreignAgentsIn({
    records,
    members: [A("a"), A("c"), A("1")],
    ownAgentPubkeys: [A("c")],
    selfNode: A("9"),
  });
  assert.deepEqual(foreign, [{ pubkey: A("a"), name: "smith", node: A("b") }]);
});

test("foreignMentions resolves both spellings against the foreign roster only", () => {
  const foreign = [
    { pubkey: A("a"), name: "smith", node: A("b") },
    { pubkey: A("e"), name: "fizz", node: A("b") },
  ];
  const byName = foreignMentions({
    event: { kind: 9, pubkey: A("7"), content: "smith is great but @smith should answer", tags: [] },
    foreign,
  });
  assert.deepEqual(byName, [{ pubkey: A("a"), name: "smith", node: A("b") }]);

  const byTag = foreignMentions({
    event: { kind: 9, pubkey: A("7"), content: "you there?", tags: [["mention", A("e"), "agent-address"]] },
    foreign,
  });
  assert.deepEqual(byTag, [{ pubkey: A("e"), name: "fizz", node: A("b") }]);

  const nobody = foreignMentions({
    event: { kind: 9, pubkey: A("7"), content: "quiet afternoon", tags: [] },
    foreign,
  });
  assert.deepEqual(nobody, []);
});

test("foreignMentions ignores non-channel-message kinds", () => {
  const foreign = [{ pubkey: A("a"), name: "smith", node: A("b") }];
  assert.deepEqual(
    foreignMentions({ event: { kind: 7, pubkey: A("7"), content: "@smith", tags: [] }, foreign }),
    [],
  );
});
