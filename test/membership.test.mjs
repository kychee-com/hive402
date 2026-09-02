// FIX-120 — channels come from the relay, not from a config file (AC-48).
//
// ── The second list, and why it had to go ─────────────────────────────────
//
// A config file said which channels the node watched. That list is invisible to
// the room, and it disagrees with the relay in both directions:
//
//   • an agent added to a channel in Buzz Desktop stays deaf there until
//     somebody edits JSON on the node's machine and restarts it;
//   • an agent REMOVED from a channel is still launched with it, so the owner's
//     action in their own client did not do what it looked like.
//
// AC-48: "Channel membership, which every member can already see and change in
// their client, IS the per-channel permission surface — there is no second list
// in a config file that the room cannot see and that can silently disagree
// with it."
//
// The primitive is `buzz channels list --member`, run AS THE AGENT: "Only show
// channels where the current identity is a member" (ChannelsCmd at buzz
// origin/main 29f2054c).

import { test } from "node:test";
import assert from "node:assert/strict";

import { channelsForAgent, membershipDelta, readMemberships } from "../src/registry/membership.mjs";

const A = "b86d8eda-5f05-496c-af45-ef4442ad5876";
const B = "11111111-2222-3333-4444-555555555555";
const C = "99999999-8888-7777-6666-555555555555";

const cliWith = (rows, { fail = null } = {}) => ({
  async myChannels() {
    if (fail) throw new Error(fail);
    return rows;
  },
});

// ── Reading a membership ──────────────────────────────────────────────────

test("an agent's channels are whatever the relay says they are", async () => {
  const found = await channelsForAgent({ cli: cliWith([{ channel: A }, { channel: B }]) });
  assert.deepEqual(found, [A, B]);
});

test("the channel id is read under any of the spellings buzz has used", async () => {
  // Read defensively on purpose: this is a third party's JSON, the field has a
  // different name in three places upstream already, and a rename would
  // otherwise present as "every agent is in no channels".
  const found = await channelsForAgent({
    cli: cliWith([{ channel_id: A }, { channelId: B }, { id: C }]),
  });
  assert.deepEqual(found, [A, B, C]);
});

test("duplicates and blanks are dropped rather than watched twice", async () => {
  const found = await channelsForAgent({
    cli: cliWith([{ channel: A }, { channel: A }, { channel: "" }, {}, { channel: B }]),
  });
  assert.deepEqual(found, [A, B]);
});

test("a relay that cannot be read THROWS — it does not report an empty membership", async () => {
  // The failure mode this exists to prevent: a network blip renders as "this
  // agent belongs nowhere", the node stops watching every channel, and a
  // working room goes silent for a reason nobody can see.
  await assert.rejects(
    channelsForAgent({ cli: cliWith([], { fail: "relay unreachable" }) }),
    /unreachable/,
  );
});

// ── What changed ──────────────────────────────────────────────────────────

test("a channel added in another client is a join", () => {
  const delta = membershipDelta([A], [A, B]);
  assert.deepEqual(delta.joined, [B]);
  assert.deepEqual(delta.left, []);
  assert.equal(delta.changed, true);
});

test("a channel removed in another client is a leave", () => {
  const delta = membershipDelta([A, B], [A]);
  assert.deepEqual(delta.joined, []);
  assert.deepEqual(delta.left, [B]);
  assert.equal(delta.changed, true);
});

test("no change is no change, so a re-check costs nothing", () => {
  // The re-check runs on an interval forever. If "same membership" did not
  // compare equal, every tick would tear down and relaunch every agent.
  assert.equal(membershipDelta([A, B], [A, B]).changed, false);
  assert.equal(membershipDelta([], []).changed, false);
});

test("order is not a change", () => {
  assert.equal(membershipDelta([A, B], [B, A]).changed, false);
});

// ── Two agents, two answers ───────────────────────────────────────────────

test("two agents with disjoint channel sets are read separately", () => {
  // The case a per-ROOM config could not express at all: the config listed a
  // channel and put agents under it, so every agent in a room watched the same
  // channel by construction. Membership is per identity.
  const rows = { spike: [{ channel: A }], blitz: [{ channel: B }, { channel: C }] };
  return readMemberships({
    agents: [{ name: "spike" }, { name: "blitz" }],
    cliFor: (agent) => cliWith(rows[agent.name]),
  }).then(({ memberships, failures }) => {
    assert.deepEqual(memberships.get("spike"), [A]);
    assert.deepEqual(memberships.get("blitz"), [B, C]);
    assert.deepEqual(failures, []);
  });
});

test("one agent's relay failure does not silence the others", async () => {
  const { memberships, failures } = await readMemberships({
    agents: [{ name: "spike" }, { name: "blitz" }],
    cliFor: (agent) =>
      agent.name === "spike" ? cliWith([], { fail: "no key for spike" }) : cliWith([{ channel: B }]),
  });
  assert.equal(memberships.has("spike"), false, "no reading for the one that failed");
  assert.deepEqual(memberships.get("blitz"), [B], "and the one that worked is unaffected");
  assert.deepEqual(failures, [{ agent: "spike", reason: "no key for spike" }]);
});

// ── The config field that no longer decides ──────────────────────────────

import { configDeprecations } from "../src/config/schema.mjs";

test("a config with rooms[].channel is told the field no longer decides", () => {
  const [warning] = configDeprecations({ rooms: [{ channel: A }, { channel: B }] });
  assert.match(warning, /no longer decides/);
  assert.match(warning, /channel membership does/i);
  assert.match(warning, new RegExp(A));
  assert.match(warning, new RegExp(B));
  // It must say what still uses it, or the reader assumes it can delete it.
  assert.match(warning, /if the relay cannot be reached/i);
});

test("a config without channels has nothing to warn about", () => {
  assert.deepEqual(configDeprecations({}), []);
  assert.deepEqual(configDeprecations({ rooms: [] }), []);
  assert.deepEqual(configDeprecations(null), []);
});
