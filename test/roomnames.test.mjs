// AC-37 — agent names are unique per room (DD-17, fix cycle 2).
//
// F-008: two SEPARATE node instances, each with its own config file and its own
// state directory (which is exactly how two different owners are set up — it is
// the normal topology, not an edge case), each registered an agent called
// "probe1" into the same channel with different pubkeys. Both succeeded.
//
// The cause was that `existingAgents` came from `room.agents` in the LOCAL
// CONFIG FILE, so the check could only ever see the registering owner's own
// agents. Another owner's node is structurally invisible to it. Uniqueness is a
// property of the ROOM, so the room is what has to be asked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { claimedNamesInRoom } from "../src/registry/roomnames.mjs";
import { validateRegistration } from "../src/registry/registration.mjs";

const A = "11".repeat(32);
const B = "22".repeat(32);
const C = "33".repeat(32);
const OWNER = "44".repeat(32);
const SPONSOR = "55".repeat(32);

function fakeCli({ members = [], profiles = {}, byName = {}, fail = null } = {}) {
  return {
    calls: [],
    async channelMembers() {
      if (fail === "members") throw new Error("relay unreachable");
      return members;
    },
    async getUser({ pubkey, name }) {
      if (fail === "users") throw new Error("relay unreachable");
      if (pubkey) return profiles[pubkey] ?? null;
      return byName[String(name).toLowerCase()] ?? null;
    },
  };
}

test("a name published by another owner's agent in the same room is found", async () => {
  const cli = fakeCli({
    members: [{ pubkey: A, role: "bot" }, { pubkey: OWNER, role: "member" }],
    profiles: { [A]: { pubkey: A, display_name: "probe1" }, [OWNER]: { pubkey: OWNER, display_name: "tal" } },
  });
  const claims = await claimedNamesInRoom({ cli, channel: "ch", exceptPubkey: B });
  assert.deepEqual(
    claims.map((c) => [c.name, c.pubkey]).sort(),
    [["probe1", A], ["tal", OWNER]].sort(),
  );
});

test("our own pubkey is never treated as a clash — re-registering an agent stays idempotent", async () => {
  const cli = fakeCli({
    members: [{ pubkey: A, role: "bot" }],
    profiles: { [A]: { pubkey: A, display_name: "probe1" } },
  });
  assert.deepEqual(await claimedNamesInRoom({ cli, channel: "ch", exceptPubkey: A }), []);
});

test("a name already resolving relay-wide counts as claimed, even outside the member list", async () => {
  // `@name` resolution is a relay-global kind-0 lookup, so a name held anywhere
  // breaks addressing everywhere. A registration that "succeeds" into a broken
  // name is worse than a refusal.
  const cli = fakeCli({
    members: [{ pubkey: OWNER, role: "member" }],
    profiles: { [OWNER]: { pubkey: OWNER, display_name: "tal" } },
    byName: { probe1: { pubkey: C, display_name: "probe1" } },
  });
  const claims = await claimedNamesInRoom({ cli, channel: "ch", exceptPubkey: B, name: "probe1" });
  const clash = claims.find((c) => c.name.toLowerCase() === "probe1");
  assert.ok(clash, "a relay-wide claim must be reported");
  assert.equal(clash.pubkey, C);
  assert.equal(clash.scope, "relay");
});

test("a member with no published profile contributes no claim rather than blowing up", async () => {
  const cli = fakeCli({ members: [{ pubkey: A, role: "bot" }], profiles: {} });
  assert.deepEqual(await claimedNamesInRoom({ cli, channel: "ch", exceptPubkey: B }), []);
});

test("a relay that cannot be read refuses rather than reporting no clashes", async () => {
  // Fail closed. "We could not check" must never render as "there is nothing
  // there" — that is precisely the answer F-008 got from the local config.
  await assert.rejects(
    () => claimedNamesInRoom({ cli: fakeCli({ fail: "members" }), channel: "ch", exceptPubkey: B }),
    /could not.*uniqueness|relay/i,
  );
});

// ── The validator sees room claims, not config entries ────────────────────

const baseAgent = { name: "probe1", pubkey: B, ownerPubkey: OWNER };
const members = new Set([SPONSOR, OWNER]);

test("a duplicate name from ANOTHER owner's node is refused", () => {
  const verdict = validateRegistration({
    agent: baseAgent,
    sponsorPubkey: SPONSOR,
    members,
    existingAgents: [{ name: "probe1", pubkey: A, scope: "room" }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /already registered in this room/);
});

test("the refusal names the pubkey holding it, so the operator can see it is not theirs", () => {
  const verdict = validateRegistration({
    agent: baseAgent,
    sponsorPubkey: SPONSOR,
    members,
    existingAgents: [{ name: "probe1", pubkey: A, scope: "room" }],
  });
  assert.match(verdict.reason, /1111/);
});

test("a relay-wide clash is refused with a distinct reason", () => {
  const verdict = validateRegistration({
    agent: baseAgent,
    sponsorPubkey: SPONSOR,
    members,
    existingAgents: [{ name: "probe1", pubkey: C, scope: "relay" }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /relay/i);
});

test("the same agent re-registering is not a clash", () => {
  const verdict = validateRegistration({
    agent: baseAgent,
    sponsorPubkey: SPONSOR,
    members,
    existingAgents: [{ name: "probe1", pubkey: B, scope: "room" }],
  });
  assert.equal(verdict.ok, true);
});

test("a clash is decided case-insensitively, as @name resolution is", () => {
  const verdict = validateRegistration({
    agent: { ...baseAgent, name: "Probe1" },
    sponsorPubkey: SPONSOR,
    members,
    existingAgents: [{ name: "probe1", pubkey: A, scope: "room" }],
  });
  assert.equal(verdict.ok, false);
});
