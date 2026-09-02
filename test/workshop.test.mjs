// FIX-45 / DD-27: the workshop deploys on a RECORD, never on a boolean.
//
// This file used to prove that `buildAndDeploy` worked when handed
// `approved: true`. It did — and nothing in the product ever called it (issue
// #4). The boolean is gone: the module reads the same on-disk authority record
// every tool call is judged against, verifies it with the same
// `coversCapability`, and spends it. A caller cannot hand-roll permission.
//
// Whether the PRODUCT reaches this module is proved in workshop-deploy.test.mjs
// through the Dispatcher and the Supervisor, which is the half that was missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAndDeploy, formatDeployMessage } from "../src/workshop/run402.mjs";
import { parseConfig } from "../src/config/schema.mjs";
import { readAuthority, writeGrant, writeWithheld } from "../src/runtime/grants.mjs";

const SIGNATURE = "Bash|run402 sites deploy-dir ./site --project prj_1";
const TOKEN = "h4-1abcd";

const agent = { name: "blitz", build: true };

function fakeRun402({ url = "https://shared-todo.run402.com", receipt = "dpl_abc123" } = {}) {
  const calls = [];
  return {
    calls,
    async deploy(args) {
      calls.push(args);
      return { ok: true, url, receipt };
    },
  };
}

// An approved deploy, exactly as the node writes it: keyed by the proposal
// token, carrying the capability, the proposal and the refused call.
function approve(stateDir, over = {}) {
  return writeGrant({
    stateDir,
    agent: agent.name,
    eventId: TOKEN,
    capabilities: ["build"],
    reason: `approved by owner (${TOKEN})`,
    proposalId: TOKEN,
    signature: SIGNATURE,
    ...over,
  });
}

const state = () => mkdtempSync(path.join(tmpdir(), "hive402-workshop-"));

const deploy = (stateDir, run402, over = {}) =>
  buildAndDeploy({
    stateDir,
    agent,
    project: "prj_1",
    dir: path.join(stateDir, "work", "blitz", "site"),
    token: TOKEN,
    signature: SIGNATURE,
    run402,
    ...over,
  });

// ── The happy path ────────────────────────────────────────────────────────

test("an approved deploy reaches run402 and returns the live url (AC-29)", async () => {
  const stateDir = state();
  approve(stateDir);
  const run402 = fakeRun402();
  const r = await deploy(stateDir, run402);

  assert.equal(r.ok, true, r.reason);
  assert.equal(r.url, "https://shared-todo.run402.com");
  assert.equal(run402.calls.length, 1);
  assert.equal(run402.calls[0].project, "prj_1", "the project comes from config, never from the agent");
});

test("the deploy carries a receipt to post back (AC-30)", async () => {
  const stateDir = state();
  approve(stateDir);
  const r = await deploy(stateDir, fakeRun402());
  assert.equal(r.receipt, "dpl_abc123");
});

// ── Nothing but a real record deploys anything ────────────────────────────

test("no authority record at all deploys nothing", async () => {
  const stateDir = state();
  const run402 = fakeRun402();
  const r = await deploy(stateDir, run402);
  assert.equal(r.ok, false);
  assert.equal(run402.calls.length, 0);
  assert.match(r.reason, /no capability grant/i);
});

test("a withheld record deploys nothing", async () => {
  const stateDir = state();
  writeWithheld({ stateDir, agent: agent.name, eventId: TOKEN, reason: "not the owner" });
  const run402 = fakeRun402();
  const r = await deploy(stateDir, run402);
  assert.equal(r.ok, false);
  assert.equal(run402.calls.length, 0);
  assert.match(r.reason, /withheld/i);
});

test("an expired record deploys nothing", async () => {
  const stateDir = state();
  approve(stateDir, { now: Date.now() - 60 * 60 * 1000 });
  const run402 = fakeRun402();
  const r = await deploy(stateDir, run402);
  assert.equal(r.ok, false);
  assert.equal(run402.calls.length, 0);
  assert.match(r.reason, /expired/i);
});

test("a record for a DIFFERENT call deploys nothing (DD-21)", async () => {
  // The owner approved a deploy; the node must not be able to spend it on some
  // other command that happened to be refused the same way.
  const stateDir = state();
  approve(stateDir, { signature: "Bash|run402 up --name somebody-elses-project -y" });
  const run402 = fakeRun402();
  const r = await deploy(stateDir, run402);
  assert.equal(r.ok, false);
  assert.equal(run402.calls.length, 0);
  assert.match(r.reason, /named a different action/i);
});

test("one approval, one deploy: the second attempt deploys nothing", async () => {
  const stateDir = state();
  approve(stateDir);
  const run402 = fakeRun402();

  assert.equal((await deploy(stateDir, run402)).ok, true);
  const second = await deploy(stateDir, run402);

  assert.equal(second.ok, false);
  assert.equal(run402.calls.length, 1, "the approval was already spent");
  assert.match(second.reason, /already been used/i);
});

test("the approval is spent BEFORE run402 is called, so a crash cannot be retried into a second deploy", async () => {
  const stateDir = state();
  approve(stateDir);
  const exploded = {
    calls: [],
    async deploy() {
      throw new Error("gateway timeout");
    },
  };
  const r = await deploy(stateDir, exploded);
  assert.equal(r.ok, false);
  assert.match(r.reason, /gateway timeout/);
  assert.ok(readAuthority({ stateDir, agent: agent.name, eventId: TOKEN }).consumedAt, "spent anyway");
});

test("a build-disabled agent deploys nothing even holding an approval (AC-17 before AC-14)", async () => {
  const stateDir = state();
  approve(stateDir);
  const run402 = fakeRun402();
  const r = await deploy(stateDir, run402, { agent: { ...agent, build: false } });
  assert.equal(r.ok, false);
  assert.equal(run402.calls.length, 0);
  assert.match(r.reason, /"build" is disabled/);
  assert.ok(
    !readAuthority({ stateDir, agent: agent.name, eventId: TOKEN }).consumedAt,
    "and the capability refusal comes first, so the approval is not even spent",
  );
});

test("a failed deploy is reported honestly, not as success", async () => {
  const stateDir = state();
  approve(stateDir);
  const r = await deploy(stateDir, {
    calls: [],
    async deploy() {
      return { ok: false, error: "build failed: missing entrypoint" };
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing entrypoint/);
});

// ── What the room is told ─────────────────────────────────────────────────

test("the channel message carries the live url and the receipt (AC-29, AC-30)", () => {
  const msg = formatDeployMessage({
    project: "prj_1",
    url: "https://shared-todo.run402.com",
    receipt: "dpl_abc123",
    identity: "barry's run402 account",
  });
  assert.match(msg, /shared-todo\.run402\.com/);
  assert.match(msg, /dpl_abc123/);
});

test("the message discloses WHOSE identity the deploy ran under", () => {
  // The interim deploy identity is the owner's run402 account (issue #2 gives
  // the agent its own). A room that cannot see whose money moved cannot judge
  // the deploy at all, so this is stated in the room rather than in a doc.
  const msg = formatDeployMessage({
    project: "prj_1",
    url: "https://x.run402.com",
    receipt: "dpl_1",
    identity: "the run402 account of spike's owner (71a12235)",
  });
  assert.match(msg, /71a12235/);
  assert.match(msg, /spike's owner/);
  assert.match(msg, /not .*agent|agent .*never/i, `no disclosure of who did NOT hold it: ${msg}`);
});

test("the message carries the AC-31 adoption pointer, naming the project", () => {
  const msg = formatDeployMessage({
    project: "prj_1",
    url: "https://x.run402.com",
    receipt: "dpl_1",
    identity: "owner",
  });
  assert.match(msg, /run402 transfer init/, "the existing run402 adoption flow, reachable from the room");
  assert.match(msg, /prj_1/);
});

test("a deploy with no bound subdomain says there is no live url, and never guesses one", () => {
  // MEASURED 2026-08-18: run402 returns `"url": ""` for a project with no
  // subdomain bound, and the deployed bytes really are unreachable. A guessed
  // hostname would put a 404 in the room under the word "Live".
  const msg = formatDeployMessage({
    project: "prj_1",
    url: null,
    receipt: "dpl_abc123",
    identity: "owner",
  });
  assert.match(msg, /Live: not yet/);
  assert.match(msg, /dpl_abc123/, "the receipt still proves the deploy happened");
  assert.match(msg, /run402 subdomains claim <name> --project prj_1 --deployment dpl_abc123/, "and what would fix it");
  assert.ok(!/https?:\/\/\S*run402\.com/.test(msg.split("To co-own")[0]), `invented a url: ${msg}`);
});

test("a subdomain claim that failed after a real deploy is surfaced, not hidden", () => {
  const msg = formatDeployMessage({
    project: "prj_1",
    url: null,
    receipt: "dpl_abc123",
    identity: "owner",
    warning: "hive402-dresstest is already claimed (SUBDOMAIN_TAKEN)",
  });
  assert.match(msg, /already claimed/);
});

test("no em dash reaches the room", () => {
  // Outbound writing rule: a room message is product copy that humans read.
  const msg = formatDeployMessage({ project: "p", url: "u", receipt: "r", identity: "owner" });
  assert.ok(!msg.includes("—"), msg);
});

// ── The workshop config block (per room) ──────────────────────────────────

const baseConfig = (workshop) => ({
  relayUrl: "wss://relay.example",
  node: { pubkey: "9".repeat(64) },
  rooms: [
    {
      channel: "11111111-1111-1111-1111-111111111111",
      respondTo: "anyone",
      agents: [{ name: "blitz", pubkey: "b".repeat(64), ownerPubkey: "a".repeat(64) }],
      ...(workshop === undefined ? {} : { workshop }),
    },
  ],
});

test("a room with no workshop block has no workshop", () => {
  assert.equal(parseConfig(baseConfig()).rooms[0].workshop, null);
});

test("a workshop block names the project, and optionally the subdomain", () => {
  const room = parseConfig(baseConfig({ project: "prj_1", subdomain: "shared-todo" })).rooms[0];
  assert.deepEqual(room.workshop, { project: "prj_1", subdomain: "shared-todo" });
});

test("a typo in the workshop block is refused, not ignored", () => {
  // Same rule as every other setting: a silently ignored key is an owner
  // believing they configured something they did not.
  assert.throws(() => parseConfig(baseConfig({ projectId: "prj_1" })), /unknown workshop setting "projectId"/);
  assert.throws(() => parseConfig(baseConfig({ project: "" })), /workshop\.project/);
  assert.throws(() => parseConfig(baseConfig({ subdomain: "x" })), /workshop\.project/);
  assert.throws(() => parseConfig(baseConfig("prj_1")), /workshop must be/);
});
