import { test } from "node:test";
import assert from "node:assert/strict";

import { IdentityPublisher } from "../src/identity/publisher.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";

const agent = { name: "spike", pubkey: AGENT, ownerPubkey: OWNER };
const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });

// Stands in for BuzzCli. `directory` is what the relay would return for a
// lookup — empty means "this agent is not published".
function fakeCli({ directory = [], failSetProfile = null } = {}) {
  const calls = [];
  return {
    calls,
    async setProfile(args) {
      calls.push({ op: "setProfile", ...args });
      if (failSetProfile) throw new Error(failSetProfile);
      directory = [{ pubkey: AGENT, display_name: args.name }];
      return { accepted: true };
    },
    async getUser({ pubkey, name }) {
      calls.push({ op: "getUser", pubkey, name });
      return (
        directory.find((u) =>
          pubkey ? u.pubkey === pubkey : u.display_name?.toLowerCase() === name?.toLowerCase(),
        ) ?? null
      );
    },
  };
}

test("publishing an agent puts its display name in the relay directory", async () => {
  // This is the F-001 root cause: with no published profile, no client can
  // resolve "@spike" to a pubkey, so the message is refused before it is sent.
  const cli = fakeCli();
  const pub = new IdentityPublisher({ cli });
  const report = await pub.publish({ agent, authTag });

  assert.equal(report.published, true);
  assert.equal(report.addressable, true);
  assert.equal(cli.calls[0].op, "setProfile");
  assert.equal(cli.calls[0].name, "spike");
});

test("the published profile carries the owner attestation, not just a name", async () => {
  const cli = fakeCli();
  const report = await new IdentityPublisher({ cli }).publish({ agent, authTag });
  assert.equal(report.attested, true);
  assert.equal(report.owner, OWNER);
});

test("publishing without an attestation is refused — a nameless-owner agent is not an agent", async () => {
  const cli = fakeCli();
  await assert.rejects(
    () => new IdentityPublisher({ cli }).publish({ agent, authTag: null }),
    /attestation/i,
  );
});

test("an attestation that does not verify for this agent is refused before publishing", async () => {
  // Guards against wiring a tag computed for a different agent into the launch
  // path, which would publish an identity nobody can verify.
  const wrongTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: "ab".repeat(32) });
  const cli = fakeCli();
  await assert.rejects(
    () => new IdentityPublisher({ cli }).publish({ agent, authTag: wrongTag }),
    /attestation/i,
  );
  assert.equal(cli.calls.length, 0, "must not publish anything when the attestation is bad");
});

test("an unpublished agent is reported unaddressable by the node, not left to fail in the sender's client", async () => {
  // AC-39: the node itself says the agent cannot be reached, rather than the
  // human discovering it as a raw relay error when they try to talk to it.
  const cli = fakeCli({ directory: [] });
  const report = await new IdentityPublisher({ cli }).check({ agent });
  assert.equal(report.addressable, false);
  assert.match(report.problems.join(" "), /not addressable|no published profile/i);
});

test("an agent published under a different name than the room expects is reported", async () => {
  const cli = fakeCli({ directory: [{ pubkey: AGENT, display_name: "stale-name" }] });
  const report = await new IdentityPublisher({ cli }).check({ agent });
  assert.equal(report.addressable, false);
  assert.match(report.problems.join(" "), /stale-name/);
});

test("a name that resolves to somebody else's pubkey is reported as a collision", async () => {
  const cli = fakeCli({ directory: [{ pubkey: "ff".repeat(32), display_name: "spike" }] });
  const report = await new IdentityPublisher({ cli }).check({ agent });
  assert.equal(report.addressable, false);
  assert.match(report.problems.join(" "), /another identity|collision/i);
});

test("a healthy agent reports addressable with no problems", async () => {
  const cli = fakeCli({ directory: [{ pubkey: AGENT, display_name: "spike" }] });
  const report = await new IdentityPublisher({ cli }).check({ agent });
  assert.equal(report.addressable, true);
  assert.deepEqual(report.problems, []);
});

test("a failed publish surfaces the relay's reason instead of reporting success", async () => {
  const cli = fakeCli({ failSetProfile: "relay refused: not a member" });
  await assert.rejects(
    () => new IdentityPublisher({ cli }).publish({ agent, authTag }),
    /not a member/,
  );
});

test("the keepalive republishes only once the refresh window has elapsed", async () => {
  let clock = 0;
  const cli = fakeCli();
  const pub = new IdentityPublisher({ cli, now: () => clock, refreshMs: 1000 });
  await pub.publish({ agent, authTag });
  const afterFirst = cli.calls.filter((c) => c.op === "setProfile").length;

  clock = 500;
  await pub.keepalive({ agent, authTag });
  assert.equal(
    cli.calls.filter((c) => c.op === "setProfile").length,
    afterFirst,
    "must not republish inside the refresh window",
  );

  clock = 1500;
  await pub.keepalive({ agent, authTag });
  assert.equal(
    cli.calls.filter((c) => c.op === "setProfile").length,
    afterFirst + 1,
    "must republish once the window has elapsed",
  );
});

// FOUND BY LOOKING AT THE ROOM (Barry, 2026-08-25).
//
// A hive402 agent sat in the member list with no picture, next to a human
// member who had one. AC-46 had the avatar filed as exploratory — "whether a
// client renders a picture hive402 publishes is unverified" — and that framing
// was measuring the wrong thing. Rendering was never in doubt: the human's
// picture rendering in the same list is the proof it works. hive402 simply
// never published one. `publish()` sent `{name, about}` and the agent schema
// had no field to put a picture in.
test("an agent's configured avatar is published", async () => {
  const sent = [];
  const cli = {
    async setProfile(fields) { sent.push(fields); return { accepted: true }; },
    async getUser({ pubkey }) {
      return pubkey ? { pubkey: AGENT, display_name: "spike", tags: [] } : { pubkey: AGENT };
    },
  };
  await new IdentityPublisher({ cli }).publish({
    agent: { name: "spike", pubkey: AGENT, ownerPubkey: OWNER, avatar: "https://example.com/spike.png" },
    authTag: authTag,
  });
  assert.equal(sent[0].avatar, "https://example.com/spike.png");
  assert.equal(sent[0].name, "spike");
});

test("an agent with no avatar does not CLEAR the one it has", async () => {
  // `users set-profile` is read-merge-write upstream, and BuzzCli sends only
  // the fields it is given. Passing an explicit empty avatar on every publish
  // would wipe a picture set anywhere else, on every keepalive.
  const sent = [];
  const cli = {
    async setProfile(fields) { sent.push(fields); return { accepted: true }; },
    async getUser({ pubkey }) {
      return pubkey ? { pubkey: AGENT, display_name: "spike", tags: [] } : { pubkey: AGENT };
    },
  };
  await new IdentityPublisher({ cli }).publish({
    agent: { name: "spike", pubkey: AGENT, ownerPubkey: OWNER },
    authTag: authTag,
  });
  assert.equal(sent[0].avatar, undefined, "no avatar key at all, rather than an empty one");
});

// FOUND BY RUNNING `up` AFTER RE-REGISTERING (2026-08-26).
//
// The attester was compared against ONE identity, and the supervisor passed
// none — so it fell back to `agent.ownerPubkey`, the human. The moment an agent
// was re-registered under FIX-117 the NODE became its attester, and the node
// then refused to publish its own agent:
//
//     agent "smith": attestation names bead5b81…, expected 800fab4d…
//
// Both are legitimate, and which applies depends on WHEN the agent was
// registered. What must stay refused is a foreign attestation.
test("an agent attested by the NODE publishes", async () => {
  const cli = fakeCli({ directory: [{ pubkey: AGENT, display_name: "spike" }] });
  const nodeSk = "2222222222222222222222222222222222222222222222222222222222222222";
  const nodeTag = computeAuthTag({ ownerPrivateKey: nodeSk, agentPubkey: AGENT });
  const nodePk = nodeTag[1];
  await new IdentityPublisher({ cli }).publish({
    agent: { name: "spike", pubkey: AGENT, ownerPubkey: OWNER },
    authTag: nodeTag,
    attestedBy: nodePk,
  });
  assert.ok(cli.calls.some((c) => c.op === "setProfile"), "it published");
});

test("an agent attested by the declared HUMAN owner still publishes", async () => {
  // Everything registered before FIX-117 is in this state, including on a live
  // community. An upgrade must not stop them starting.
  const cli = fakeCli({ directory: [{ pubkey: AGENT, display_name: "spike" }] });
  await new IdentityPublisher({ cli }).publish({
    agent: { name: "spike", pubkey: AGENT, ownerPubkey: OWNER },
    authTag,
    attestedBy: "3".repeat(64), // a node that did NOT attest it
  });
  assert.ok(cli.calls.some((c) => c.op === "setProfile"));
});

test("a FOREIGN attestation is still refused", async () => {
  const strangerSk = "4444444444444444444444444444444444444444444444444444444444444444";
  const strangerTag = computeAuthTag({ ownerPrivateKey: strangerSk, agentPubkey: AGENT });
  await assert.rejects(
    new IdentityPublisher({ cli: fakeCli() }).publish({
      agent: { name: "spike", pubkey: AGENT, ownerPubkey: OWNER },
      authTag: strangerTag,
      attestedBy: "3".repeat(64),
    }),
    /neither this node nor the owner this config declares/,
  );
});
