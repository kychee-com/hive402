import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { registryRecordCheck, registryRecordReport } from "../src/node/doctor.mjs";
import { registerAgent } from "../src/node/runtime.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";

// F-041 / DD-75: an agent nobody can cover for is a health failure, not a
// picker footnote.
//
// A covering node acts only on agents whose kind-30177 record is AUTHORED by
// their hosting node (foreign.mjs). An agent with no such record — never
// registered here, tombstoned, or attested by some other key — can never draw
// an AC-61 notice or an AC-63 replay while its node is down. doctor must say
// so, name the consequence, and name the fix (AC-57). `up` already logs the
// publish refusal; it must say the same consequence, not only "@ picker".

const NODE = "9".repeat(64);
const AGENT = "4".repeat(64);
const OTHER = "7".repeat(64);
const row = ({ author = NODE, agent = AGENT, name = "spike", at = 100 } = {}) => ({
  kind: 30177,
  pubkey: author,
  created_at: at,
  tags: [["d", agent]],
  content: JSON.stringify({ name }),
});

test("a live record authored by this node is ok", () => {
  const r = registryRecordCheck({ rows: [row()], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE });
  assert.equal(r.state, "ok");
  assert.equal(r.ok, true);
});

test("no record at all: FAIL, naming the cover consequence and the register action", () => {
  const r = registryRecordCheck({ rows: [], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE });
  assert.equal(r.state, "absent");
  assert.equal(r.ok, false);
  assert.match(r.detail, /cannot cover for spike/i);
  assert.match(r.detail, /AC-61/);
  assert.match(r.detail, /hive402 register --agent spike/);
});

test("a tombstone (empty name) counts as absent, not as a record", () => {
  const r = registryRecordCheck({ rows: [row({ name: "" })], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE });
  assert.equal(r.state, "absent");
  assert.equal(r.ok, false);
});

test("a record authored by another key is 'attested elsewhere' — re-register so THIS node attests it", () => {
  // The rig's own case: spike attested by a human dev key on 2026-08-15,
  // before the node had its own identity. The record exists, but not under
  // the node that hosts the agent, so this node's peers cannot read "offline"
  // for it — and this node's own publish is (correctly) refused every launch.
  const r = registryRecordCheck({ rows: [row({ author: OTHER })], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE });
  assert.equal(r.state, "attested-elsewhere");
  assert.equal(r.ok, false);
  assert.match(r.detail, new RegExp(OTHER.slice(0, 12)));
  assert.match(r.detail, /re-register|hive402 register --agent spike/i);
  assert.match(r.detail, /cannot cover/i);
});

test("a record under this node beside a stale one elsewhere is contested — and says so", () => {
  // foreign.mjs drops a contested agent whole (two authors, one agent), so a
  // peer would cover for nobody. That is worse than absent and must not read
  // as ok just because our own row exists.
  const r = registryRecordCheck({ rows: [row(), row({ author: OTHER })], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE });
  assert.equal(r.state, "contested");
  assert.equal(r.ok, false);
  assert.match(r.detail, /contested|two/i);
});

test("absent, attested by THIS node: the remedy is 'up' (it publishes on launch) — Tal's case right after register", () => {
  const r = registryRecordCheck({ rows: [], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE, attestedBy: NODE });
  assert.equal(r.state, "absent");
  assert.equal(r.ok, false);
  assert.match(r.detail, /attested by this node/i);
  assert.match(r.detail, /hive402 up/);
  assert.match(r.detail, /cannot cover for spike/i);
});

test("absent, attested by ANOTHER key: the remedy is re-register — the rig's case", () => {
  const r = registryRecordCheck({ rows: [], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE, attestedBy: OTHER });
  assert.equal(r.state, "absent");
  assert.equal(r.ok, false);
  assert.match(r.detail, new RegExp(OTHER.slice(0, 12)));
  assert.match(r.detail, /not this node/i);
  assert.match(r.detail, /hive402 register --agent spike/);
  assert.doesNotMatch(r.detail, /hive402 up/, "up cannot fix an attestation by another key");
});

test("rows for other agents never count for this one", () => {
  const r = registryRecordCheck({ rows: [row({ agent: OTHER })], agentName: "spike", agentPubkey: AGENT, nodePubkey: NODE });
  assert.equal(r.state, "absent");
});

test("a relay read failure is 'could not check' — no verdict at all, so never ok and never a false FAIL", () => {
  const agents = [{ name: "spike", pubkey: AGENT }];
  const r = registryRecordReport({ rows: null, error: new Error("ECONNREFUSED"), agents, nodePubkey: NODE });
  assert.equal(r.lines.length, 0, "an unreadable relay earns no per-agent verdict");
  assert.match(r.warn, /could not check/);
  assert.match(r.warn, /ECONNREFUSED/);
  assert.match(r.warn, /assume no other node can cover/i);

  // And the same reader, fed a good read, is what prints the per-agent lines.
  const good = registryRecordReport({ rows: [row()], error: null, agents, nodePubkey: NODE });
  assert.equal(good.warn, null);
  assert.equal(good.lines.length, 1);
  assert.equal(good.lines[0].ok, true);
  assert.match(good.lines[0].text, /^registry record for spike: /);
  const bad = registryRecordReport({ rows: [], error: null, agents, nodePubkey: NODE });
  assert.equal(bad.lines[0].ok, false);
  assert.match(bad.lines[0].text, /hive402 register --agent spike/);
});

test("doctor wires the check and prints the consequence; up's refusal names it too", () => {
  // Structural: the sentence a human reads must exist at both seams.
  const cli = readFileSync(new URL("../bin/cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /registryRecordReport/, "doctor must print the registry report");
  assert.match(cli, /report\.lines/, "doctor must print every per-agent line the report returns");
  assert.match(cli, /verifyAuthTag/, "doctor must verify who signed the local attestation, not trust a field");
  const doctor = readFileSync(new URL("../src/node/doctor.mjs", import.meta.url), "utf8");
  assert.match(doctor, /registry record for/, "the per-agent registry line is built by the report");
  assert.match(cli, /publishRecord: publishManagedAgent/, "register must publish the record a peer covers from");
  const sup = readFileSync(new URL("../src/node/supervisor.mjs", import.meta.url), "utf8");
  assert.match(sup, /cannot cover for/, "up's non-fatal refusal must name the cover consequence (AC-61), not only the picker");
});

// ── register publishes the record a peer covers from (FIX-209/210) ──────────
//
// `up` republishes it on every launch, but the operator's next step after
// `register` is `doctor` (the second-host runbook says so), and a FAIL that
// reads "no other node can cover for Maple" right after a clean registration
// is a false alarm. The record is published at registration, by the attester,
// and only when the attester is this node.

const NODE_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const NODE_PK = derivePubkey(NODE_SK);
const AGENT_SK = "1".repeat(64);
const AGENT_PK = derivePubkey(AGENT_SK);
const HUMAN_SK = "2".repeat(64);
const HUMAN_PK = derivePubkey(HUMAN_SK);
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const relayDouble = ({ members = [NODE_PK, HUMAN_PK] } = {}) => ({
  make: () => ({
    async channelMembers() { return members.map((pubkey) => ({ pubkey })); },
    async joinChannel() { return { accepted: true }; },
    async getUser({ pubkey }) { return pubkey === AGENT_PK ? { pubkey: AGENT_PK, name: "spike", tags: [] } : null; },
    async addChannelMember() { return {}; },
    async setProfile() { return {}; },
  }),
});

async function registerSpike({ publishRecord, ownerKeyRef, members } = {}) {
  process.env.F041_HUMAN_KEY = HUMAN_SK;
  return registerAgent({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE_PK, privateKeyRef: "keychain" },
      tools: { buzzDir: null },
      rooms: [{ channel: CHANNEL, agents: [{ name: "spike", pubkey: AGENT_PK, ownerPubkey: HUMAN_PK, privateKeyRef: "keychain" }] }],
    },
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-f041-")),
    agentName: "spike",
    ownerKeyRef,
    resolveKey: async (ref, ctx) => {
      if (ref?.startsWith?.("env:")) return process.env[ref.slice(4)];
      if (ctx?.agent) return AGENT_SK;
      return NODE_SK;
    },
    makeCli: relayDouble({ members }).make,
    publishRecord,
  });
}

test("register publishes the managed-agent record, signed by the node, so peers can cover (AC-61)", async () => {
  const calls = [];
  const result = await registerSpike({ publishRecord: async (args) => { calls.push(args); } });
  assert.equal(calls.length, 1, "exactly one record publish");
  assert.equal(calls[0].ownerPrivateKeyHex, NODE_SK, "signed by the attesting NODE, the only key the record may carry");
  assert.equal(calls[0].agent.name, "spike");
  assert.equal(calls[0].respondTo, "anyone", "the same record up publishes");
  assert.equal(calls[0].origin, "http://localhost:3000");
  assert.ok(Array.isArray(calls[0].authTag) && calls[0].authTag[0] === "auth", "carries the attestation it just signed");
  assert.equal(result.recordPublished, true);
  assert.equal(result.recordWarning, null);
});

test("a dev-relay --owner-key attester is NOT the node: no record, and the warning names the cover consequence", async () => {
  const calls = [];
  const result = await registerSpike({ publishRecord: async (args) => { calls.push(args); }, ownerKeyRef: "env:F041_HUMAN_KEY" });
  assert.equal(calls.length, 0, "a record naming a human key as the hosting node would be covered for forever");
  assert.equal(result.recordPublished, false);
  assert.match(result.recordWarning, /cannot cover for spike/i);
  assert.match(result.recordWarning, /AC-61/);
  assert.match(result.recordWarning, new RegExp(HUMAN_PK.slice(0, 12)));
});

test("a failed record publish is a warning naming up as the retry, never a failed registration", async () => {
  const result = await registerSpike({ publishRecord: async () => { throw new Error("relay said no"); } });
  assert.equal(result.name, "spike", "the agent IS registered");
  assert.equal(result.recordPublished, false);
  assert.match(result.recordWarning, /relay said no/);
  assert.match(result.recordWarning, /hive402 up/);
  assert.match(result.recordWarning, /cannot cover for spike/i);
});

test("a channel join the relay accepted but did not apply is named as such, with the action (FIX-210)", async () => {
  // The rig's own case: the node's key was the relay's key, which a relay never
  // lists as a member. join → accepted; roster → unchanged; the generic
  // "must be sponsored by an existing community member" sent us to re-check a
  // community join that had already succeeded.
  await assert.rejects(
    () => registerSpike({ members: [HUMAN_PK] }),
    (err) => {
      assert.match(err.message, /roster still does not list it/i);
      assert.match(err.message, /Buzz client/);
      assert.match(err.message, /relay never lists itself/i);
      assert.match(err.message, new RegExp(NODE_PK.slice(0, 12)));
      return true;
    },
  );
});

test("a library caller that hands over no publisher gets no network call and no warning", async () => {
  const result = await registerSpike({});
  assert.equal(result.recordPublished, false);
  assert.equal(result.recordWarning, null);
});
