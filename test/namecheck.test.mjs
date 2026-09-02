// FIX-118 — a name collision is caught BEFORE the identity exists (AC-56).
//
// ── What was already there, and what was not ───────────────────────────────
//
// `claimedNamesInRoom` (cycle 2, F-008) asks the ROOM who holds a name, in two
// scopes: members of the channel, and global `@name` resolution at the relay.
// `validateRegistration` refuses on either. That is AC-37 and it works.
//
// AC-56 asks for something else. Two things, in fact:
//
//   1. "before the agent exists". The check ran at `register`, which is AFTER
//      `keygen` minted a key, wrote it to the OS credential store, printed a
//      pubkey and told the operator to put it in their config. By the time the
//      clash was reported, the identity it was about already existed and had to
//      be cleaned up by hand.
//   2. "the owner's own clients". An owner may already have an agent of that
//      name that they made in Buzz Desktop — attested by their own key, not by
//      this node. That is not a room clash and not a relay clash; it is the
//      owner colliding with themselves, and AC-56 says at minimum they are TOLD.
//      A refusal would be wrong: they may well mean to move it here.
//
// Upstream supplies exactly the lookup that answers (2): `buzz users get --name
// <n> --owner <hex|npub|me>` — "Scope an exact-name agent lookup to its owner"
// (UsersCmd at buzz origin/main 29f2054c).

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkAgentName, describeNameFindings } from "../src/registry/namecheck.mjs";

const AGENT_PK = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const OTHER_PK = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const OWNER_PK = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

// A relay double whose three questions can be answered independently, because
// the whole point of this task is that they are three different questions.
function relay({ members = [], byName = null, byOwner = null, fail = null } = {}) {
  const asked = [];
  return {
    asked,
    async channelMembers() {
      asked.push({ q: "members" });
      if (fail === "members") throw new Error("relay unreachable");
      return members.map((m) => ({ pubkey: m.pubkey }));
    },
    async getUser({ pubkey, name, owner }) {
      asked.push({ q: "getUser", pubkey, name, owner });
      if (fail === "getUser") throw new Error("relay unreachable");
      if (pubkey) return members.find((m) => m.pubkey === pubkey) ?? null;
      if (owner) return byOwner;
      return byName;
    },
  };
}

// ── The two refusing scopes, unchanged in meaning ─────────────────────────

test("a name held by another member of the room is a refusal", async () => {
  const r = relay({ members: [{ pubkey: OTHER_PK, name: "spike" }] });
  const found = await checkAgentName({ cli: r, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK });
  assert.equal(found.checked, true);
  assert.equal(found.refusals.length, 1);
  assert.equal(found.refusals[0].scope, "room");
  assert.deepEqual(found.warnings, []);
});

test("a name that already resolves anywhere on the relay is a refusal", async () => {
  // `@name` resolution is a global kind-0 lookup, so registering into someone
  // else's name produces an agent that is admitted and unaddressable.
  const r = relay({ byName: { pubkey: OTHER_PK, name: "spike" } });
  const found = await checkAgentName({ cli: r, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK });
  assert.equal(found.refusals[0].scope, "relay");
});

// ── AC-56's own scope: the owner colliding with themselves ────────────────

test("a name the OWNER already holds elsewhere is a warning, not a refusal", async () => {
  // They may well mean to move that agent here. Refusing would be hive402
  // deciding a question that belongs to the person.
  const r = relay({ byOwner: { pubkey: OTHER_PK, name: "spike" } });
  const found = await checkAgentName({
    cli: r, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK, ownerPubkey: OWNER_PK,
  });
  assert.deepEqual(found.refusals, []);
  assert.equal(found.warnings.length, 1);
  assert.equal(found.warnings[0].scope, "owner");
  assert.equal(found.warnings[0].pubkey, OTHER_PK);
});

test("the owner scope is asked with the owner's key, which is what upstream takes", async () => {
  const r = relay({});
  await checkAgentName({
    cli: r, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK, ownerPubkey: OWNER_PK,
  });
  const scoped = r.asked.find((a) => a.owner);
  assert.equal(scoped.owner, OWNER_PK);
  assert.equal(scoped.name, "spike");
});

test("with no owner known, the owner question is not asked at all", async () => {
  // Better than asking it against the wrong identity and reporting a clash
  // that is not one.
  const r = relay({});
  await checkAgentName({ cli: r, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK });
  assert.equal(r.asked.some((a) => a.owner), false);
});

test("finding YOURSELF is not a collision", async () => {
  const r = relay({
    members: [{ pubkey: AGENT_PK, name: "spike" }],
    byName: { pubkey: AGENT_PK, name: "spike" },
    byOwner: { pubkey: AGENT_PK, name: "spike" },
  });
  const found = await checkAgentName({
    cli: r, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK, ownerPubkey: OWNER_PK,
  });
  assert.deepEqual(found.refusals, []);
  assert.deepEqual(found.warnings, []);
});

test("the comparison is case-insensitive, because @name resolution is", async () => {
  const r = relay({ members: [{ pubkey: OTHER_PK, name: "Spike" }] });
  const found = await checkAgentName({ cli: r, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK });
  assert.equal(found.refusals.length, 1);
});

// ── When it cannot be checked at all ──────────────────────────────────────

test("no relay client means NOT CHECKED, said plainly — never a silent pass", async () => {
  // `keygen` runs before there is a config, or offline. Reporting "no clash"
  // when nothing was asked is the exact failure the local-config check made in
  // cycle 2 (F-008): "we could not check" rendering as "there is nothing there".
  const found = await checkAgentName({ cli: null, name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK });
  assert.equal(found.checked, false);
  assert.match(found.reason, /no relay/i);
  assert.deepEqual(found.refusals, []);
});

test("a relay that cannot be read is NOT CHECKED, with the reason", async () => {
  const found = await checkAgentName({
    cli: relay({ fail: "members" }), name: "spike", channel: CHANNEL, selfPubkey: AGENT_PK,
  });
  assert.equal(found.checked, false);
  assert.match(found.reason, /unreachable/i);
});

test("with no channel, the relay-wide question is still asked", async () => {
  // At `keygen` there may be no room yet. The global name lookup does not need
  // one, and it is the check that catches the worst outcome.
  const r = relay({ byName: { pubkey: OTHER_PK, name: "spike" } });
  const found = await checkAgentName({ cli: r, name: "spike", channel: null, selfPubkey: AGENT_PK });
  assert.equal(found.checked, true);
  assert.equal(found.refusals[0].scope, "relay");
  assert.equal(r.asked.some((a) => a.q === "members"), false);
});

// ── What the operator is actually told ────────────────────────────────────

test("a refusal names the holder and says the name is unusable", async () => {
  const said = describeNameFindings({
    name: "spike",
    findings: { checked: true, refusals: [{ scope: "relay", pubkey: OTHER_PK, name: "spike" }], warnings: [] },
  });
  assert.match(said.error, /spike/);
  assert.match(said.error, new RegExp(OTHER_PK.slice(0, 12)));
  assert.match(said.error, /already resolves/i);
  assert.equal(said.warnings.length, 0);
});

test("a warning says it is the owner's own, and does not stop anything", async () => {
  const said = describeNameFindings({
    name: "spike",
    findings: { checked: true, refusals: [], warnings: [{ scope: "owner", pubkey: OTHER_PK, name: "spike" }] },
  });
  assert.equal(said.error, null);
  assert.match(said.warnings[0], /you already have/i);
  assert.match(said.warnings[0], new RegExp(OTHER_PK.slice(0, 12)));
});

test("not-checked is reported as not-checked, not as clean", async () => {
  const said = describeNameFindings({
    name: "spike",
    findings: { checked: false, reason: "no relay configured yet", refusals: [], warnings: [] },
  });
  assert.equal(said.error, null);
  assert.match(said.warnings[0], /could not check/i);
  assert.match(said.warnings[0], /no relay configured yet/);
});

// ── Through the real keygen, which is the point of "before it exists" ─────

import { keygen } from "../src/credentials/keys.mjs";
import { CredentialStore } from "../src/credentials/store.mjs";
import { makeNameCheck } from "../src/registry/namecheckcommand.mjs";

function fakeKeychain() {
  const held = new Map();
  const k = (s, a) => `${s} ${a}`;
  return {
    held,
    async get(s, a) { return held.get(k(s, a)) ?? null; },
    async set(s, a, v) { held.set(k(s, a), v); },
    async create(s, a, v) {
      if (held.has(k(s, a))) { const e = new Error("exists"); e.exists = true; throw e; }
      held.set(k(s, a), v);
    },
    async remove(s, a) { return held.delete(k(s, a)); },
    async list() { return [...held.keys()]; },
  };
}

test("REAL KEYGEN: a clashing name is refused and NO key is generated", async () => {
  // The defect AC-56 names. Before this, the clash surfaced at `register` —
  // after keygen had minted a key, written it to the OS credential store,
  // printed a pubkey and told the operator to paste it into their config.
  const kc = fakeKeychain();
  const store = new CredentialStore({ keychain: kc });
  await assert.rejects(
    keygen({
      store,
      target: { kind: "agent", name: "spike" },
      log: () => {},
      generate: () => { throw new Error("a key must NOT be generated for a clashing name"); },
      nameCheck: async (name) => ({ error: `the name "${name}" already resolves`, warnings: [] }),
    }),
    /already resolves/,
  );
  assert.deepEqual([...kc.held.keys()], [], "nothing was written to the credential store");
});

test("REAL KEYGEN: a warning is printed and the key is still made", async () => {
  const kc = fakeKeychain();
  const lines = [];
  await keygen({
    store: new CredentialStore({ keychain: kc }),
    target: { kind: "agent", name: "spike" },
    log: (l) => lines.push(String(l)),
    generate: () => "1".repeat(64),
    nameCheck: async () => ({ error: null, warnings: ["you already have an agent called \"spike\""] }),
  });
  assert.match(lines.join("\n"), /you already have an agent called "spike"/);
  assert.equal(kc.held.size, 1, "the identity was still created — a warning is not a refusal");
});

test("REAL KEYGEN: the node's own identity is not name-checked", async () => {
  // `--node` has no room, no `@name` and nothing to collide with. Asking would
  // be a relay round trip that can only ever answer "no".
  const kc = fakeKeychain();
  await keygen({
    store: new CredentialStore({ keychain: kc }),
    target: { kind: "node" },
    log: () => {},
    generate: () => "2".repeat(64),
    nameCheck: async () => { throw new Error("the node identity must not be name-checked"); },
  });
  assert.equal(kc.held.size, 1);
});

// ── The assembled checker, when there is nothing to assemble it from ──────

test("with no config and no join record, the check says so instead of passing", async () => {
  const check = await makeNameCheck({
    config: null,
    stateDir: null,
    store: new CredentialStore({ keychain: fakeKeychain() }),
    log: () => {},
  });
  const said = await check("spike");
  assert.equal(said.error, null, "it must not BLOCK — the refusal that matters is at register");
  assert.match(said.warnings[0], /could not check/i);
  assert.match(said.warnings[0], /has not joined/i);
});

test("with a relay but no node identity, it says that instead", async () => {
  const check = await makeNameCheck({
    config: { relayUrl: "ws://localhost:3000", tools: {} },
    stateDir: null,
    store: new CredentialStore({ keychain: fakeKeychain() }),
    log: () => {},
  });
  const said = await check("spike");
  assert.match(said.warnings[0], /no identity yet/i);
});

test("the assembled checker narrows to the room and owner the config already knows", async () => {
  const kc = fakeKeychain();
  // AC-72: the node's key lives under its OWN pubkey, and the config is what
  // names which hive is asking. Seeded under the machine-wide label, this
  // checker would correctly find nothing and ask the relay nothing.
  const NODE_PK = "5".repeat(64);
  await kc.set("hive402:node-private-key", NODE_PK, "3".repeat(64));
  const asked = [];
  const check = await makeNameCheck({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE_PK },
      tools: {},
      rooms: [{ channel: CHANNEL, agents: [{ name: "spike", pubkey: AGENT_PK, ownerPubkey: OWNER_PK }] }],
    },
    stateDir: null,
    store: new CredentialStore({ keychain: kc }),
    makeCli: () => ({
      async channelMembers() { asked.push("members"); return []; },
      async getUser(args) { asked.push(args); return null; },
    }),
    log: () => {},
  });
  await check("spike");
  assert.ok(asked.includes("members"), "it asked the room the agent is actually in");
  assert.ok(asked.some((a) => a?.owner === OWNER_PK), "and scoped a lookup to the owner");
});
