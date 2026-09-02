// AC-70 / AC-71 (DD-60): retiring an agent gives its name back.
//
// `register` claims a room-unique name (AC-37) and nothing ever gave one back,
// so a decommissioned agent burned that name in that room forever. F-024 is
// that defect rehearsed at rig scale: the cover belt tombstoned the kind-30177
// registry record, deleted the key, and burned two display names per cleanup —
// because the surface that actually refuses the next registration is the
// kind-0 DISPLAY NAME (`roomnames.mjs` reads channel members' kind-0 plus the
// relay's global index; it never reads 30177 at all).
//
// So retirement releases BOTH surfaces, in an order that cannot half-succeed,
// and proves the release with the same reader that would refuse the next
// registration. What it cannot free, it says so about — it never reports
// success for a name that is still held.

import { test } from "node:test";
import assert from "node:assert/strict";

import { authorizeRetire, retireAgent, retiredNameFor } from "../src/registry/retire.mjs";
import { parseConfig } from "../src/config/schema.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const STRANGER = "cc".repeat(32);
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const agent = (over = {}) => ({
  name: "spike",
  pubkey: SPIKE,
  ownerPubkey: OWNER,
  privateKeyRef: "env:SPIKE",
  ...over,
});

// A relay that answers the two questions `claimedNamesInRoom` asks, and records
// every write in the order it happened — the order IS the property under test.
function fakeRelay({ holders = {}, failTombstone = false, failRename = false } = {}) {
  const calls = [];
  // pubkey -> display name currently published
  const profiles = new Map(Object.entries(holders));
  const cli = {
    async channelMembers() {
      return [...profiles.keys()].map((pubkey) => ({ pubkey }));
    },
    async getUser({ pubkey, name }) {
      if (pubkey) {
        const display = profiles.get(String(pubkey).toLowerCase());
        return display ? { pubkey, display_name: display } : null;
      }
      // `users get --name` is a TOKEN match upstream, not an exact one: a
      // profile called `retired-spike-43e1b966` comes back for "spike". So the
      // fake matches the same way, and the product must ask "does anything
      // still CALL ITSELF this", not "does anything come back".
      const wanted = String(name).toLowerCase();
      for (const [pubkey, display] of profiles) {
        if (String(display).toLowerCase().split(/[-\s]+/).includes(wanted)) {
          return { pubkey, display_name: display };
        }
      }
      return null;
    },
    async setProfile({ name }, ctx = {}) {
      if (failRename) throw new Error("relay said no");
      calls.push({ step: "rename", name, as: ctx.as ?? "agent" });
      profiles.set(String(ctx.as ?? SPIKE).toLowerCase(), name);
      return { accepted: true };
    },
  };
  return {
    cli,
    calls,
    profiles,
    // The node's 30177 write, injected the same way the supervisor injects its
    // relay door elsewhere.
    async submitEvent({ event }) {
      if (failTombstone) throw new Error("the relay refused the record");
      calls.push({ step: "tombstone", d: event.tags.find((t) => t[0] === "d")?.[1] });
      return { published: true };
    },
  };
}

const run = (relay, over = {}) =>
  retireAgent({
    agent: agent(),
    channel: CHANNEL,
    nodePubkey: NODE,
    origin: "http://localhost:3000",
    resolveKey: async () => "aa".repeat(32),
    makeCli: ({ privateKey, as }) => ({
      ...relay.cli,
      setProfile: (args) => relay.cli.setProfile(args, { as: as ?? SPIKE }),
      _privateKey: privateKey,
    }),
    submitEvent: relay.submitEvent,
    ...over,
  });

// ── The retired name is unique per identity ────────────────────────────────

test("AC-70: the retired name carries the identity, so retiring twice cannot collide", () => {
  assert.equal(retiredNameFor("spike", SPIKE), `retired-spike-${SPIKE.slice(0, 8)}`);
  assert.notEqual(retiredNameFor("spike", SPIKE), retiredNameFor("spike", TAL));
});

// ── Who may retire (AC-71, first clause) ───────────────────────────────────

test("AC-71: the agent's owner may retire it", () => {
  assert.equal(authorizeRetire({ agent: agent(), actorPubkey: OWNER, nodePubkey: NODE }).ok, true);
});

test("AC-71: the node hosting it may retire it", () => {
  assert.equal(authorizeRetire({ agent: agent(), actorPubkey: NODE, nodePubkey: NODE }).ok, true);
});

test("AC-71: nobody else may — a name claimed by somebody else's key is not theirs to take", () => {
  const verdict = authorizeRetire({ agent: agent(), actorPubkey: STRANGER, nodePubkey: NODE });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /owner|host/i);
});

test("AC-71: an agent this node does not host cannot be retired from here", () => {
  const verdict = authorizeRetire({ agent: null, actorPubkey: OWNER, nodePubkey: NODE });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not.*host|no agent/i);
});

// ── The order, and what a crash between steps leaves behind (DD-60) ────────

test("AC-70: the name is released BEFORE the record is retired", async () => {
  const relay = fakeRelay({ holders: { [SPIKE]: "spike", [OWNER]: "Barry" } });
  const result = await run(relay);
  assert.equal(result.ok, true);
  assert.deepEqual(
    relay.calls.map((c) => c.step),
    ["rename", "tombstone"],
    "rename first: a crash after it leaves the name FREE and a stale record, which is recoverable",
  );
});

test("AC-70: a tombstone failure still leaves the name FREE, and says so honestly", async () => {
  const relay = fakeRelay({ holders: { [SPIKE]: "spike" }, failTombstone: true });
  const result = await run(relay);
  assert.equal(result.released, true, "the name is given back either way — that is the recoverable direction");
  assert.equal(result.retired, false, "and the record is NOT claimed as retired");
  assert.equal(result.ok, false, "so the command does not report success");
  assert.match(result.reason, /record/i);
});

test("AC-71: a rename failure reports no release at all — nothing is claimed", async () => {
  const relay = fakeRelay({ holders: { [SPIKE]: "spike" }, failRename: true });
  const result = await run(relay);
  assert.equal(result.released, false);
  assert.equal(result.ok, false);
  assert.deepEqual(relay.calls, [], "and nothing else ran: the record outlives a name we could not free");
});

// ── The proof: free at BOTH scopes (the fix-cycle-15 discriminator) ────────

test("AC-70: success requires the name free in the room AND at the relay index", async () => {
  const relay = fakeRelay({ holders: { [SPIKE]: "spike", [OWNER]: "Barry" } });
  const result = await run(relay);
  assert.equal(result.ok, true);
  assert.deepEqual(result.freeAt, ["room", "relay"]);
  assert.equal(
    relay.profiles.get(SPIKE),
    `retired-spike-${SPIKE.slice(0, 8)}`,
    "the identity keeps a dead name rather than vanishing — a vanished profile and a renamed one both read free",
  );
});

test("AC-71: a name still held by SOMEBODY ELSE is never reported as freed", async () => {
  // The F-024 residue shape exactly: our config calls this agent `spike`, but
  // the name in the room is held by a different pubkey. Renaming our own
  // identity frees nothing, and saying otherwise is the lie AC-71 forbids.
  const relay = fakeRelay({ holders: { [SPIKE]: "spike", [STRANGER]: "spike" } });
  const result = await run(relay);
  assert.equal(result.ok, false);
  assert.match(result.reason, /still held/i);
  assert.match(result.reason, new RegExp(STRANGER.slice(0, 8)), "naming the holder");
  assert.match(result.reason, /room|relay/, "and the scope");
});

// ── No key, no release — and no cheerful lie (AC-71, second clause) ────────

// ── A retired agent is not relaunched (AC-70: it is no longer addressable) ──

const configWith = (agentOver = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:N" },
  rooms: [
    {
      channel: CHANNEL,
      agents: [
        { name: "spike", pubkey: SPIKE, ownerPubkey: OWNER, privateKeyRef: "env:S", ...agentOver },
        { name: "keeper", pubkey: TAL, ownerPubkey: OWNER, privateKeyRef: "env:K" },
      ],
    },
  ],
});

test("AC-70: a retired agent leaves room.agents, so nothing launches, publishes or re-claims for it", () => {
  // ONE seam, deliberately. Every consumer — the launcher, the profile
  // publisher, the key pre-flight, the dispatcher's roster — reads
  // `room.agents`, so removing it here is what makes "no longer addressable"
  // true everywhere at once instead of in whichever places remembered to ask.
  // Without this, the next `hive402 up` republishes the kind-0 and takes the
  // name straight back, which would make retirement purely decorative.
  const parsed = parseConfig(configWith({ retired: true }));
  assert.deepEqual(parsed.rooms[0].agents.map((a) => a.name), ["keeper"]);
  assert.deepEqual(parsed.rooms[0].retiredAgents.map((a) => a.name), ["spike"]);
});

test("a live agent is untouched by the flag's absence", () => {
  const parsed = parseConfig(configWith());
  assert.deepEqual(parsed.rooms[0].agents.map((a) => a.name), ["spike", "keeper"]);
  assert.deepEqual(parsed.rooms[0].retiredAgents, []);
});

test("retired must be a real boolean — a typo must not silently retire an agent", () => {
  assert.throws(() => parseConfig(configWith({ retired: "yes" })), /retired/);
});

test("AC-71: with no signing key for the claim, retire REFUSES and names the holder", async () => {
  const relay = fakeRelay({ holders: { [SPIKE]: "spike" } });
  const result = await run(relay, {
    resolveKey: async () => {
      throw new Error("no key for spike in the credential store");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.released, false);
  assert.match(result.reason, /key/i, "says WHY it cannot be freed");
  assert.match(result.reason, new RegExp(SPIKE.slice(0, 8)), "and who still holds it");
  assert.deepEqual(relay.calls, [], "nothing was written on a run that could not succeed");
});
