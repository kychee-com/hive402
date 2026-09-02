// FIX-123 — hive402 agents are pickable (AC-51, AC-39).
//
// ── The measurement this is built on ───────────────────────────────────────
//
// Barry opened his `@` menu on 2026-08-26. It listed Bzik, Honey, Pollen and
// Fizz, three of them marked "not in channel", and did NOT list `smith` — a bot
// sitting in that very channel. Querying the live relay for kind 30177 returned
// ten records, one for each agent in the menu, and none for smith.
//
// So the picker is built from kind 30177, keyed `(author, 30177, d=<agent
// pubkey>)`, and hive402 wrote none. Nothing about the gap was ever
// agent-specific: Desktop's agents appear because Desktop writes this record.
//
// ── The rule that makes this possible only after FIX-117 ──────────────────
//
// Desktop keeps a 30177 only when its AUTHOR is the agent's verified NIP-OA
// owner (`latest_verified_managed_policies`), and on a release build drops
// every entry with no verified owner at all
// (`retain_agents_allowed_by_build`). An agent attested by a HUMAN would need
// that human's key, which AC-43 forbids hive402 to hold. An agent attested by
// the NODE can have its record written by the node.
//
// That is why the mismatch is refused here rather than published and left to be
// dropped: a record a client silently discards looks exactly like no record at
// all, and the cause is invisible from the room.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManagedAgentEvent, managedAgentContent, publishManagedAgent, KIND_MANAGED_AGENT } from "../src/identity/managedagent.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { eventId, pubkeyOf } from "../src/identity/nostrevent.mjs";
import { nip98Header } from "../src/identity/nip98.mjs";

const NODE_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const NODE_PK = pubkeyOf(NODE_SK);
const HUMAN_SK = "1111111111111111111111111111111111111111111111111111111111111111";
const AGENT_PK = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const now = 1_700_000_000_000;

const agent = (over = {}) => ({ name: "smith", pubkey: AGENT_PK, ...over });
const nodeAttests = computeAuthTag({ ownerPrivateKey: NODE_SK, agentPubkey: AGENT_PK });
const humanAttests = computeAuthTag({ ownerPrivateKey: HUMAN_SK, agentPubkey: AGENT_PK });

// ── The coordinate ────────────────────────────────────────────────────────

test("the record is keyed on the AGENT, and authored by its owner", () => {
  const { event } = buildManagedAgentEvent({
    agent: agent(), authTag: nodeAttests, ownerPrivateKeyHex: NODE_SK, now,
  });
  assert.equal(event.kind, KIND_MANAGED_AGENT);
  assert.equal(event.pubkey, NODE_PK, "the AUTHOR is the owner");
  assert.deepEqual(
    event.tags.find((t) => t[0] === "d"),
    ["d", AGENT_PK],
    "and the d tag is the AGENT — swapping them makes a record about the wrong identity that still verifies",
  );
});

test("the event id is the NIP-01 serialisation, so a relay will accept it", () => {
  const { event } = buildManagedAgentEvent({
    agent: agent(), authTag: nodeAttests, ownerPrivateKeyHex: NODE_SK, now,
  });
  assert.equal(event.id, eventId(event));
});

// ── The rule ──────────────────────────────────────────────────────────────

test("a record signed by anyone but the verified owner is REFUSED, not published", () => {
  // The whole point. Desktop drops this one silently, so publishing it would
  // produce the exact symptom it was meant to fix, with the cause invisible.
  assert.throws(
    () =>
      buildManagedAgentEvent({
        agent: agent(), authTag: humanAttests, ownerPrivateKeyHex: NODE_SK, now,
      }),
    /would be dropped without trace|Re-register the agent/,
  );
});

test("an agent with no verifiable attestation gets no record", () => {
  assert.throws(
    () => buildManagedAgentEvent({ agent: agent(), authTag: null, ownerPrivateKeyHex: NODE_SK, now }),
    /no verifiable owner attestation/,
  );
  assert.throws(
    () =>
      buildManagedAgentEvent({
        agent: agent(), authTag: ["auth", NODE_PK, "", "00".repeat(64)], ownerPrivateKeyHex: NODE_SK, now,
      }),
    /no verifiable owner attestation/,
  );
});

test("an agent with no pubkey has nothing to key a record on", () => {
  assert.throws(
    () => buildManagedAgentEvent({ agent: { name: "smith" }, authTag: nodeAttests, ownerPrivateKeyHex: NODE_SK, now }),
    /needs a pubkey/,
  );
});

// ── What the content may carry ────────────────────────────────────────────

test("the content is the allowlisted projection and nothing else", () => {
  const { content } = managedAgentContent({ agent: agent() });
  assert.deepEqual(Object.keys(content).sort(), ["name", "parallelism", "respond_to"]);
  assert.equal(content.name, "smith");
});

test("an empty allowlist is omitted, a real one is carried", () => {
  // Upstream: `skip_serializing_if = "Vec::is_empty"`. These are PUBLIC keys.
  assert.equal("respond_to_allowlist" in managedAgentContent({ agent: agent() }).content, false);
  const withList = managedAgentContent({ agent: agent({ respondToAllowlist: [NODE_PK] }) }).content;
  assert.deepEqual(withList.respond_to_allowlist, [NODE_PK]);
});

test("no secret can reach a world-readable event", () => {
  // Upstream says the projection "physically cannot represent" a key, an auth
  // tag or env vars. hive402 builds the same shape and asserts the same absence
  // rather than trusting the caller not to pass one.
  const { serialised } = managedAgentContent({
    agent: agent({ privateKey: NODE_SK, authTag: nodeAttests, envVars: { A: "b" } }),
  });
  assert.ok(!serialised.includes(NODE_SK), "no private key");
  assert.ok(!serialised.includes("authTag") && !serialised.includes("auth"), "no auth tag");
  assert.ok(!serialised.toLowerCase().includes("env"), "no env vars");
});

test("respond_to must be a value the reader understands", () => {
  // A wire string Desktop cannot parse means the record is dropped and the
  // agent silently fails to appear — the same symptom as publishing nothing.
  for (const ok of ["owner-only", "allowlist", "anyone"]) {
    assert.doesNotThrow(() => managedAgentContent({ agent: agent(), respondTo: ok }), ok);
  }
  assert.throws(() => managedAgentContent({ agent: agent(), respondTo: "owner-approves" }), /respond_to must be/);
});

// ── Publishing ────────────────────────────────────────────────────────────

test("it goes to POST /events, NIP-98 signed by the author", async () => {
  const calls = [];
  await publishManagedAgent({
    agent: agent(), authTag: nodeAttests, ownerPrivateKeyHex: NODE_SK,
    origin: "https://relay.example", now, nip98: nip98Header,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(calls[0].url, "https://relay.example/events");
  assert.equal(calls[0].method, "POST");
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.kind, KIND_MANAGED_AGENT);

  const header = calls[0].headers.Authorization;
  assert.match(header, /^Nostr /);
  const auth = JSON.parse(Buffer.from(header.replace(/^Nostr /, ""), "base64").toString("utf8"));
  assert.equal(auth.kind, 27235, "the HTTP auth is NIP-98");
  assert.equal(auth.pubkey, NODE_PK, "signed by the same identity that authored the record");
  assert.equal(auth.tags.find((t) => t[0] === "u")?.[1], "https://relay.example/events");
});

test("a trailing slash on the origin does not produce a double slash", async () => {
  const calls = [];
  await publishManagedAgent({
    agent: agent(), authTag: nodeAttests, ownerPrivateKeyHex: NODE_SK,
    origin: "https://relay.example/", now, nip98: nip98Header,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(calls[0].url, "https://relay.example/events");
});

test("a refusal from the relay carries the relay's own reason", async () => {
  await assert.rejects(
    publishManagedAgent({
      agent: agent(), authTag: nodeAttests, ownerPrivateKeyHex: NODE_SK,
      origin: "https://relay.example", now, nip98: nip98Header,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: "not_a_member" }) }),
    }),
    /not_a_member/,
  );
});
