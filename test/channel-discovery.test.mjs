// FIX-120, through the supervisor: the relay decides which channels are
// watched (AC-48, DD-48).
//
// `membership.test.mjs` covers the reading. This covers the thing AC-48 is
// actually about, which is a behaviour of the running node:
//
//   "Adding an agent to a channel in any Buzz client is sufficient to make that
//    channel live for it, and removing it there stops it."
//
// Nothing on the node's machine is edited and nothing is restarted by hand in
// any test here. The only thing that changes is what the relay answers.
//
// The channel subscription is a PROCESS argument (`buzz-acp --channels`), so a
// membership change also has to restart the agent's harness — a running agent
// is subscribed to the list it was launched with and nothing else. That is
// asserted too, because a node that watches a new channel while the agent is
// still subscribed to the old one produces wakes nobody answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const BLITZ = "1f2e3d4c5b6a798877665544332211009988776655443322110099887766554d";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

const A = "b86d8eda-5f05-496c-af45-ef4442ad5876";
const B = "11111111-2222-3333-4444-555555555555";

const agent = (name, pubkey) => ({
  name,
  pubkey,
  ownerPubkey: OWNER,
  privateKeyRef: `env:KEY_${name.toUpperCase()}`,
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  replyMode: "addressed-only",
});

// The config still names the agents this node hosts — that is what a config is
// for. What it no longer decides is WHERE they are. `rooms[].channel` is here
// because the schema still requires one during the deprecation window, and
// every test below proves the relay's answer is what actually gets used.
const config = (agents = [agent("spike", SPIKE)]) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
  rooms: [{ channel: A, agents }],
});

// A relay whose membership answers can be changed mid-test — which is exactly
// what "somebody added the agent to a channel in Buzz Desktop" looks like from
// here.
function relay({ membership = {} } = {}) {
  const state = { membership: { ...membership } };
  const asked = [];
  const clientFor = (opts) => ({
    async myChannels() {
      const who = opts.publishesFor ?? "node";
      asked.push(who);
      const channels = state.membership[who];
      if (channels === undefined) throw new Error(`no membership scripted for ${who}`);
      return channels.map((channel) => ({ channel }));
    },
    async getMessages() {
      return [];
    },
    async send() {
      return { accepted: true, event_id: "e1" };
    },
    async setProfile() {
      return { accepted: true };
    },
    async getUser({ pubkey }) {
      if (pubkey === SPIKE) return { pubkey: SPIKE, display_name: "spike" };
      if (pubkey === BLITZ) return { pubkey: BLITZ, display_name: "blitz" };
      return null;
    },
  });
  return { state, asked, clientFor };
}

function harness({ agents = [agent("spike", SPIKE)], membership = { spike: [A] } } = {}) {
  const spawned = [];
  const r = relay({ membership });
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-disc-"));
  const sup = new Supervisor({
    config: config(agents),
    stateDir,
    spawn: (command, args, opts) => {
      spawned.push({ command, args, opts });
      return { pid: 1000 + spawned.length, killed: false, kill() { this.killed = true; } };
    },
    makeCli: r.clientFor,
    readAttestation: (a) => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: a.pubkey }),
    resolveKey: () => "bb".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
    // Re-check on every tick, so a test does not have to wait a minute for the
    // behaviour AC-48 describes.
    membershipRecheckMs: 0,
  });
  return { sup, spawned, relay: r, stateDir };
}

const channelsOf = (spawn) => {
  const at = spawn.args.indexOf("--channels");
  return at === -1 ? [] : spawn.args[at + 1].split(",");
};
const watched = (sup) => sup.watching().sort();

// ── At start ──────────────────────────────────────────────────────────────

test("the node watches the channels the RELAY says the agent is in", async () => {
  // Not channel A from the config: channel B, because that is where the relay
  // says spike is a member. Nothing in the config was changed to say so.
  const { sup, spawned } = harness({ membership: { spike: [B] } });
  await sup.start();
  assert.deepEqual(watched(sup), [B]);
  assert.deepEqual(channelsOf(spawned[0]), [B], "and the harness is subscribed to it");
});

test("an agent in two channels is ONE process subscribed to both", async () => {
  // Two processes under one identity answer every message twice — the F-008
  // duplicate class in a new place.
  const { sup, spawned } = harness({ membership: { spike: [A, B] } });
  await sup.start();
  assert.deepEqual(watched(sup), [A, B].sort());
  assert.equal(spawned.length, 1, "one agent, one harness");
  assert.deepEqual(channelsOf(spawned[0]).sort(), [A, B].sort());
});

test("two agents with disjoint channel sets are watched correctly", async () => {
  const { sup, spawned } = harness({
    agents: [agent("spike", SPIKE), agent("blitz", BLITZ)],
    membership: { spike: [A], blitz: [B] },
  });
  await sup.start();
  assert.deepEqual(watched(sup), [A, B].sort());
  assert.equal(spawned.length, 2, "two agents, two harnesses");
  const byChannels = spawned.map((s) => channelsOf(s).join(","));
  assert.deepEqual(byChannels.sort(), [A, B].sort(), "each subscribed to its own channel only");
});

// ── While it runs ─────────────────────────────────────────────────────────

test("a channel added in another client goes live on the next re-check", async () => {
  const { sup, spawned, relay: r } = harness({ membership: { spike: [A] } });
  await sup.start();
  assert.deepEqual(watched(sup), [A]);

  // Somebody adds spike to channel B in Buzz Desktop. Nothing here edits a
  // config file and nothing restarts the node.
  r.state.membership.spike = [A, B];
  await sup.tick();

  assert.deepEqual(watched(sup), [A, B].sort());
  assert.deepEqual(
    channelsOf(spawned[spawned.length - 1]).sort(),
    [A, B].sort(),
    "and the harness was restarted with the new subscription",
  );
});

test("a channel removed in another client stops being watched", async () => {
  const { sup, relay: r } = harness({ membership: { spike: [A, B] } });
  await sup.start();
  assert.deepEqual(watched(sup), [A, B].sort());

  r.state.membership.spike = [A];
  await sup.tick();
  assert.deepEqual(watched(sup), [A]);
});

test("an unchanged membership does not restart anything", async () => {
  // The re-check runs forever. If "same membership" did not compare equal,
  // every tick would kill and relaunch every agent in the room.
  const { sup, spawned } = harness({ membership: { spike: [A] } });
  await sup.start();
  const after = spawned.length;
  await sup.tick();
  await sup.tick();
  assert.equal(spawned.length, after, "no relaunch for a membership that did not change");
});

// ── When the relay cannot answer ──────────────────────────────────────────

test("a relay that cannot answer falls back to the configured channel, loudly", async () => {
  // The deprecation window (DD-48). A network blip must not render as "this
  // agent belongs nowhere" and take a working room down — but it must SAY that
  // it fell back, or the config quietly becomes a second source of truth again.
  const spawned = [];
  const said = [];
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-disc-"));
  const dead = () => ({
    async myChannels() {
      throw new Error("relay unreachable");
    },
    async getMessages() { return []; },
    async send() { return { accepted: true, event_id: "e1" }; },
    async setProfile() { return { accepted: true }; },
    async getUser({ pubkey }) { return pubkey === SPIKE ? { pubkey: SPIKE, display_name: "spike" } : null; },
  });
  const sup = new Supervisor({
    config: config(),
    stateDir,
    spawn: (command, args, opts) => {
      spawned.push({ command, args, opts });
      return { pid: 1, kill() {} };
    },
    makeCli: dead,
    readAttestation: (a) => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: a.pubkey }),
    resolveKey: () => "bb".repeat(32),
    trustWorkspace: () => {},
    log: (line) => said.push(String(line)),
    membershipRecheckMs: 0,
  });
  await sup.start();

  assert.deepEqual(watched(sup), [A], "the configured channel is the last known good");
  assert.match(said.join("\n"), /could not read spike's channel memberships/);
  assert.match(said.join("\n"), /falling back to the channels in the config/);
});

test("a relay that goes down mid-run keeps the channels it already had", async () => {
  const { sup, relay: r } = harness({ membership: { spike: [A, B] } });
  await sup.start();
  assert.deepEqual(watched(sup), [A, B].sort());

  // Not "spike is in no channels" — "we could not ask".
  delete r.state.membership.spike;
  await sup.tick();
  assert.deepEqual(watched(sup), [A, B].sort(), "a failed re-check is not an empty membership");
});
