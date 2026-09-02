// F-008, reproduced at the level it actually happened (fix cycle 2).
//
// The Red Team's repro was not a contrived edge case — it was the product's
// NORMAL topology, run twice: two config files, two state directories, two
// owners' nodes, one shared room. Both registered an agent called "probe1"
// under different pubkeys and both succeeded.
//
// Nothing in the suite covered `registerAgent` at all, so the hole was invisible
// to 254 green tests. This is that missing test, written against the same
// shared relay both nodes talk to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerAgent } from "../src/node/runtime.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const PROBE_A = "16df7761".padEnd(64, "a");
const PROBE_B = "97eb472b".padEnd(64, "b");
const CHANNEL = "6f30305c-7903-42e4-912e-502ceedf15b8";

// One relay, shared by both nodes — which is the whole point. Each node has its
// own config and state dir and cannot see the other's, exactly as two owners on
// two machines cannot.
function sharedRelay() {
  const members = [{ pubkey: OWNER, role: "member" }];
  const profiles = { [OWNER]: { pubkey: OWNER, display_name: "tal" } };
  return {
    members,
    profiles,
    makeCli: ({ privateKey, publishesFor }) => ({
      async channelMembers() {
        return members;
      },
      async getUser({ pubkey, name }) {
        if (pubkey) return profiles[pubkey.toLowerCase()] ?? null;
        const wanted = String(name).toLowerCase();
        return Object.values(profiles).find((p) => p.display_name.toLowerCase() === wanted) ?? null;
      },
      async addChannelMember({ pubkey, role }) {
        members.push({ pubkey, role });
        return { accepted: true };
      },
      async setProfile({ name, about }) {
        // `buzz users set-profile` writes the CALLING identity's profile.
        const pubkey = publishesFor === "probe1" ? probeKeyFor(privateKey) : OWNER;
        profiles[pubkey] = { pubkey, display_name: name, about };
        return { accepted: true };
      },
    }),
  };
}

// The two throwaway agent identities, keyed by the fake private key each node
// resolves for its own agent.
function probeKeyFor(privateKey) {
  return privateKey === "11".repeat(32) ? PROBE_A : PROBE_B;
}

const configFor = (agentPubkey, keyRef) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: OWNER, privateKeyRef: "env:K" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:/Buzz", nodeDir: "C:/node", adapter: "C:/adapter.js", extraDirs: [] },
  rooms: [
    {
      channel: CHANNEL,
      agents: [
        {
          name: "probe1",
          pubkey: agentPubkey,
          ownerPubkey: OWNER,
          privateKeyRef: keyRef,
          research: false,
          build: false,
          crossOwnerAsks: "owner-approves",
          selfInitiated: "asks-owner",
          replyMode: "addressed-only",
        },
      ],
    },
  ],
});

const stateDir = () => mkdtempSync(path.join(tmpdir(), "hive402-reg-"));

const resolveKey = (ref) => {
  if (ref === "env:PROBE_A_KEY") return "11".repeat(32);
  if (ref === "env:PROBE_B_KEY") return "22".repeat(32);
  return OWNER_SK; // sponsor / owner
};

async function register({ relay, agentPubkey, keyRef, dir }) {
  return registerAgent({
    config: configFor(agentPubkey, keyRef),
    stateDir: dir,
    agentName: "probe1",
    sponsorRef: "env:OWNER_KEY",
    ownerKeyRef: "env:OWNER_KEY",
    resolveKey,
    makeCli: relay.makeCli,
  });
}

test("the first registration succeeds and claims the name at the relay", async () => {
  const relay = sharedRelay();
  const result = await register({ relay, agentPubkey: PROBE_A, keyRef: "env:PROBE_A_KEY", dir: stateDir() });
  assert.equal(result.name, "probe1");
  assert.equal(result.channelRole, "bot");
  assert.equal(result.published, true, "registration must publish the name, or the next node cannot see it");
  assert.ok(relay.profiles[PROBE_A], "the claim has to be visible at the relay, not just on disk");
});

test("F-008: a SECOND node registering the same name with a different pubkey is refused", async () => {
  const relay = sharedRelay();
  await register({ relay, agentPubkey: PROBE_A, keyRef: "env:PROBE_A_KEY", dir: stateDir() });

  // A completely separate node: its own config, its own state directory, no
  // knowledge whatsoever of the first one.
  await assert.rejects(
    () => register({ relay, agentPubkey: PROBE_B, keyRef: "env:PROBE_B_KEY", dir: stateDir() }),
    /registration refused.*already registered in this room|already resolves on this relay/,
  );
  assert.equal(
    relay.members.filter((m) => m.role === "bot").length,
    1,
    "the relay must end up with exactly one bot under that name",
  );
});

test("re-registering the SAME agent from the same node still works", async () => {
  const relay = sharedRelay();
  const dir = stateDir();
  await register({ relay, agentPubkey: PROBE_A, keyRef: "env:PROBE_A_KEY", dir });
  const again = await register({ relay, agentPubkey: PROBE_A, keyRef: "env:PROBE_A_KEY", dir });
  assert.equal(again.name, "probe1");
});

test("a registration is refused when the room cannot be read, rather than admitted", async () => {
  // Fail closed: "we could not check" is not "there is no clash". The old
  // check answered from a local config, which is a different way of not
  // knowing, and it answered "no clash" every time.
  const relay = sharedRelay();
  const broken = {
    makeCli: () => ({
      async channelMembers() { throw new Error("relay unreachable"); },
      async getUser() { return null; },
      async addChannelMember() { return {}; },
      async setProfile() { return {}; },
    }),
  };
  await assert.rejects(
    () => register({ relay: broken, agentPubkey: PROBE_A, keyRef: "env:PROBE_A_KEY", dir: stateDir() }),
    /uniqueness|relay/i,
  );
  assert.equal(relay.members.filter((m) => m.role === "bot").length, 0);
});

test("the owner attestation is still written for a successful registration", async () => {
  const relay = sharedRelay();
  const dir = stateDir();
  const result = await register({ relay, agentPubkey: PROBE_A, keyRef: "env:PROBE_A_KEY", dir });
  const stored = JSON.parse(readFileSync(result.attestationFile, "utf8"));
  assert.equal(stored.pubkey, PROBE_A);
  assert.equal(stored.authTag[0], "auth");
  assert.equal(stored.authTag[1], OWNER);
});
