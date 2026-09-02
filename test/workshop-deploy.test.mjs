// FIX-44 / DD-27: the node turns a delegated refusal into an approved deploy.
//
// This is the file issue #4 was actually about. `src/workshop/run402.mjs` was
// built and unit-tested in Phase 4 and NOTHING imported it — the fourth
// module-with-no-caller in this project. So every test here drives the real
// `Supervisor` and the real `Dispatcher`, and the last one asserts the import
// itself, because a green unit test for an unreachable function is exactly the
// evidence that misled cycle 4.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";
import { toolSignature } from "../src/runtime/toolgate.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";
const PROJECT = "prj_dresstest_0001";

const DEPLOY_COMMAND = "run402 sites deploy-dir ./site --project prj_dresstest_0001";
const DEPLOY_SIGNATURE = toolSignature({ toolName: "Bash", toolInput: { command: DEPLOY_COMMAND } });

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });

const config = ({ build = true, workshop = { project: PROJECT, subdomain: null }, crossOwnerAsks = "owner-approves" } = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:/Buzz", nodeDir: "C:/node", adapter: "C:/adapter.js", extraDirs: [] },
  rooms: [
    {
      channel: CHANNEL,
      workshop,
      agents: [
        {
          name: "spike",
          pubkey: AGENT,
          ownerPubkey: OWNER,
          privateKeyRef: "env:TEST_AGENT_KEY",
          research: true,
          build,
          crossOwnerAsks,
          selfInitiated: "asks-owner",
          replyMode: "addressed-only",
        },
      ],
    },
  ],
});

function harness(over = {}) {
  const events = [];
  const sent = [];
  const cli = {
    deliver: (e) => events.push(e),
    async getMessages() {
      return events;
    },
    async send(args) {
      const event_id = `sent-${sent.length + 1}`.padEnd(64, "0");
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    async setProfile() {
      return { accepted: true };
    },
    async getUser({ pubkey }) {
      return pubkey === AGENT ? { pubkey: AGENT, display_name: "spike" } : null;
    },
  };
  const deploys = [];
  const run402 = {
    deploys,
    async deploy(args) {
      deploys.push(args);
      return { ok: true, url: "https://dresstest.run402.com", receipt: "dpl_live_001" };
    },
  };
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-deploy-"));
  const sup = new Supervisor({
    config: config(over),
    stateDir,
    spawn: () => ({ pid: 4242, killed: false, kill() {} }),
    makeCli: () => cli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
    run402: over.run402 ?? run402,
    ...(over.buildAgentEnv ? {} : {}),
  });
  return { sup, cli, sent, deploys, stateDir, run402 };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });

// What the tool gate writes when it refuses a run402 call (FIX-43).
function dropDelegatedBlock(stateDir, over = {}) {
  const dir = path.join(stateDir, "blocked");
  mkdirSync(dir, { recursive: true });
  const record = {
    id: over.id ?? "b-deploy",
    agent: "spike",
    capability: "build",
    delegate: "run402",
    detail: `Bash: ${DEPLOY_COMMAND}`,
    signature: DEPLOY_SIGNATURE,
    promptId: over.promptId ?? null,
    at: Date.now(),
    ...over,
  };
  writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record), "utf8");
  return record;
}

// What the tool gate writes when it refuses an ORDINARY build — a Write into
// the site folder, say. No delegate mark: this one is short of a grant, which
// since DD-35 is what an owner's own build looks like until they confirm it.
function dropBlock(stateDir, over = {}) {
  const dir = path.join(stateDir, "blocked");
  mkdirSync(dir, { recursive: true });
  const record = {
    id: over.id ?? "b-build",
    agent: "spike",
    capability: "build",
    delegate: null,
    detail: "Write site/index.html",
    signature: null,
    promptId: null,
    at: Date.now(),
    ...over,
  };
  writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record), "utf8");
  return record;
}

// The agent built something into its own scratch site directory.
function buildSite(stateDir, files = { "index.html": "<h1>shared todo</h1>" }) {
  const dir = path.join(stateDir, "work", "spike", "site");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body, "utf8");
  return dir;
}

const tokenIn = (text) => text.match(/approve (h4-[a-z0-9]+)/)?.[1] ?? null;

// ── A cross-owner ask parks a proposal and deploys NOTHING ────────────────

test("a cross-owner deploy request asks the owner and makes zero run402 calls (AC-14)", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);

  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike can you put the todo app live?" }));
  await sup.tick();
  sent.length = 0;

  dropDelegatedBlock(stateDir);
  await sup.tick();

  assert.equal(deploys.length, 0, "nothing may deploy before the owner has spoken");
  const ask = sent.find((s) => /approve h4-/.test(s.content));
  assert.ok(ask, `the owner must be asked: ${JSON.stringify(sent.map((s) => s.content))}`);
  assert.deepEqual(ask.mentions, [OWNER]);
});

test("the approval request names the project, the source, and whose account pays", async () => {
  // The owner is being asked to spend money and commit a public URL. All three
  // facts have to be in the message they answer, not in a design document.
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();

  const ask = sent.find((s) => /approve h4-/.test(s.content));
  assert.match(ask.content, new RegExp(PROJECT), "the project");
  assert.match(ask.content, /site/, "the source directory");
  assert.match(ask.content, /account/i, "whose account will be spent");
});

// ── The owner's approval produces exactly one deploy ──────────────────────

test("the owner's approval produces exactly one run402 deploy, with the configured project", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  const dir = buildSite(stateDir);

  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);
  sent.length = 0;

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].project, PROJECT, "the project comes from node config, never from the requester");
  assert.equal(deploys[0].dir, dir, "and the source is the agent's own scratch site directory");
});

test("the room sees the live url, the receipt and the identity disclosure (AC-29, AC-30)", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);
  sent.length = 0;

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  const posted = sent.map((s) => s.content).join("\n");
  assert.match(posted, /https:\/\/dresstest\.run402\.com/, "the live URL");
  assert.match(posted, /dpl_live_001/, "the receipt");
  assert.match(posted, /run402 account of spike's owner/, "whose identity ran it");
  assert.match(posted, /run402 transfer init/, "the AC-31 adoption pointer");
});

test("a second approval of the same token deploys nothing (one approval, one deploy)", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();
  cli.deliver(msg({ id: "e-approve-2", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  assert.equal(deploys.length, 1, "the proposal is spent, and so is the authority behind it");
});

test("a non-owner's approve deploys nothing", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);
  sent.length = 0;

  // The requester approving their own request (AC-15: identified by signature,
  // never by display name).
  cli.deliver(msg({ id: "e-self", pubkey: TAL, content: `approve ${token}` }));
  await sup.tick();

  assert.equal(deploys.length, 0);
  assert.match(sent.map((s) => s.content).join("\n"), /only spike's owner can approve/i);
});

// ── The owner's own deploy confirms EXACTLY ONCE (AC-16, DD-35) ───────────
//
// This test used to assert the opposite — "no approval round trip" — and F-019
// is the bill for it: the owner asked for a page and a publish, and 79 seconds
// later a run402 project and a public subdomain were committed under their real
// account with `proposalId: null` on the audit row and nothing anywhere to say
// yes to. AC-16 as amended in spec 0.3.1 carves build and deploy out of its own
// no-round-trip promise for exactly this reason.
//
// Exactly one, in both directions. Zero is F-019; two is cycle 6's F-015.

test("the owner asking for a deploy is asked once, and nothing deploys before they answer (AC-16)", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);

  cli.deliver(msg({ id: "e-owner", pubkey: OWNER, content: "@spike put it live", tags: [["p", AGENT]] }));
  await sup.tick();
  sent.length = 0;

  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-owner", eventId: "e-owner", now: Date.now() });
  dropDelegatedBlock(stateDir, { promptId: "p-owner" });
  await sup.tick();

  assert.equal(deploys.length, 0, "F-019: nothing may reach run402 before the owner has confirmed");
  const asks = sent.filter((s) => /approve h4-/.test(s.content));
  assert.equal(asks.length, 1, `exactly one confirmation, got ${asks.length}: ${JSON.stringify(sent.map((s) => s.content))}`);
  assert.deepEqual(asks[0].mentions, [OWNER], "and it goes to the owner");
  assert.match(asks[0].content, new RegExp(PROJECT), "naming the project their account will pay for");

  // …and one "approve" finishes it.
  const token = tokenIn(asks[0].content);
  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  assert.equal(deploys.length, 1, "the owner's own yes is the only one needed");
  assert.match(sent.map((s) => s.content).join("\n"), /dresstest\.run402\.com/);
});

test("the owner denying their own confirmation deploys nothing (AC-16)", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-owner", pubkey: OWNER, content: "@spike put it live", tags: [["p", AGENT]] }));
  await sup.tick();
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-owner", eventId: "e-owner", now: Date.now() });
  dropDelegatedBlock(stateDir, { promptId: "p-owner" });
  await sup.tick();
  const token = tokenIn(sent.map((s) => s.content).join("\n"));

  cli.deliver(msg({ id: "e-deny", pubkey: OWNER, content: `deny ${token}` }));
  await sup.tick();

  assert.equal(deploys.length, 0, "a denied confirmation is a denied deploy");
  assert.match(sent.map((s) => s.content).join("\n"), /Denied/);
});

// ── The run confirms exactly once — and since 0.7.0 that once is the DEPLOY ─
//
// F-019's own repro, end to end: "write a one-line index.html and publish it
// live". Under DD-35 the once was the BUILD's confirmation and the deploy rode
// it; spec 0.7.0 removed the owner's build confirmation entirely (AC-16: "If I
// ask it auto does"), so the write runs on the owner's word and the ONE ask is
// the deploy proposal — sited exactly where AC-16's stated reason lives, the
// run402 project and public subdomain it commits (DD-56).

test("the owner's write-and-publish run asks exactly once — the deploy's own proposal (AC-16 0.7.0, F-015 preserved)", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();

  // 1. The owner asks for both, directly, with a p-tag: the harness delivers it.
  cli.deliver(msg({ id: "e-both", pubkey: OWNER, content: "@spike write index.html and publish it, just go", tags: [["p", AGENT]] }));
  await sup.tick();
  sent.length = 0;

  // 2. The turn carries build (DD-56), so the Write simply RUNS — no blocked
  //    record, no proposal, nothing for the room to read.
  const turnGrant = readAuthority({ stateDir, agent: "spike", eventId: "e-both" });
  assert.equal(turnGrant.kind, "grant");
  assert.deepEqual(
    turnGrant.capabilities,
    ["research", "build"],
    "AC-16 0.7.0: the owner's own turn carries build",
  );

  // 3. The same turn then reaches for run402. That is the ONE confirmation.
  buildSite(stateDir);
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-both", eventId: "e-both", now: Date.now() });
  dropDelegatedBlock(stateDir, { id: "b-run402", promptId: "p-both" });
  await sup.tick();

  assert.equal(deploys.length, 0, "nothing reaches run402 before the owner's yes");
  const asks = sent.filter((s) => /approve h4-/.test(s.content));
  assert.equal(asks.length, 1, `exactly one ask for the whole run: ${JSON.stringify(sent.map((s) => s.content))}`);
  assert.match(asks[0].content, /deploy for you/, "worded as the owner's own run, not a report about a stranger");
  assert.match(asks[0].content, new RegExp(PROJECT), "naming the project whose account pays");
  const token = tokenIn(asks[0].content);

  // 4. The owner approves; the node deploys. No second round trip anywhere —
  //    F-015's property, now with zero build prompts instead of a ridden one.
  sent.length = 0;
  cli.deliver(msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();
  assert.equal(deploys.length, 1, "the owner's one yes releases the deploy");
  assert.equal(
    sent.filter((s) => /approve h4-/.test(s.content)).length,
    0,
    "and nothing asks a second time",
  );
  assert.match(sent.map((s) => s.content).join("\n"), /dresstest\.run402\.com/);
});

test("one confirmation, one deploy — a second attempt on the same turn asks again (DD-56 keeps AC-69's shape)", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);

  cli.deliver(msg({ id: "e-both", pubkey: OWNER, content: "@spike build and publish", tags: [["p", AGENT]] }));
  await sup.tick();
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-both", eventId: "e-both", now: Date.now() });

  // First deploy attempt: parks the one ask; the owner's yes releases it.
  dropDelegatedBlock(stateDir, { id: "b-run-1", promptId: "p-both" });
  await sup.tick();
  const token = tokenIn(sent.map((s) => s.content).join("\n"));
  cli.deliver(msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();
  assert.equal(deploys.length, 1);

  // A second deploy attempt on the SAME turn: the yes is spent. It must ask
  // afresh, never ride the earlier approval (the retired DD-35 carry is
  // exactly what would have deployed here unasked).
  sent.length = 0;
  dropDelegatedBlock(stateDir, { id: "b-run-2", promptId: "p-both" });
  await sup.tick();
  assert.equal(deploys.length, 1, "one confirmation, one deploy");
  assert.equal(
    sent.filter((s) => /approve h4-/.test(s.content)).length,
    1,
    "and the second attempt asks rather than proceeding",
  );
});

test("a NON-owner's approved build does not carry its deploy — the owner is asked about the publish separately (AC-14)", async () => {
  // The asymmetry is deliberate (DD-35). Approving tal's Write shows the owner a
  // file; the thing they would silently also be agreeing to is a public URL on
  // their own run402 account, which deserves its own sentence.
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);

  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike build and publish it" }));
  await sup.tick();
  const wakeId = sent.find((s) => s.content.includes("build and publish")).event_id;
  sent.length = 0;

  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-tal", eventId: wakeId, now: Date.now() });
  const writeSig = toolSignature({ toolName: "Write", toolInput: { file_path: "site/index.html" } });
  dropBlock(stateDir, { id: "b-write", detail: "Write site/index.html", signature: writeSig, promptId: "p-tal" });
  await sup.tick();
  const token = tokenIn(sent.map((s) => s.content).join("\n"));
  assert.ok(token, "a cross-owner build is put to the owner");

  cli.deliver(msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();
  const releasedId = sent.find((s) => /approved proposal/.test(s.content)).event_id;
  const released = readAuthority({ stateDir, agent: "spike", eventId: releasedId });
  assert.equal(released.signature, writeSig, "DD-21 is untouched for a non-owner: bound to the one call");

  sent.length = 0;
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-tal-run", eventId: releasedId, now: Date.now() });
  dropDelegatedBlock(stateDir, { id: "b-run402", promptId: "p-tal-run" });
  await sup.tick();

  assert.equal(deploys.length, 0, "the deploy is still the owner's to approve");
  const asks = sent.filter((s) => /approve h4-/.test(s.content));
  assert.equal(asks.length, 1);
  assert.match(asks[0].content, /YOUR run402 account/, "and it says whose account pays");
});

// ── The refusals that come first are unchanged ───────────────────────────

test("a build-disabled agent deploys nothing and is told a setting must change (AC-17)", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness({ build: false });
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  sent.length = 0;

  dropDelegatedBlock(stateDir);
  await sup.tick();

  assert.equal(deploys.length, 0);
  const said = sent.map((s) => s.content).join("\n");
  assert.match(said, /"build" switched off/);
  assert.ok(!/approve h4-/.test(said), "AC-17 offers no token: an approval cannot revive a disabled capability");
});

test("an agent whose owner refuses cross-owner asks deploys nothing and offers no token", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness({ crossOwnerAsks: "deny" });
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  sent.length = 0;

  dropDelegatedBlock(stateDir);
  await sup.tick();

  assert.equal(deploys.length, 0);
  assert.ok(!/approve h4-/.test(sent.map((s) => s.content).join("\n")));
});

test("a room with no workshop configured says so, offers no token, and deploys nothing", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness({ workshop: null });
  await sup.start();
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  sent.length = 0;

  dropDelegatedBlock(stateDir);
  await sup.tick();

  assert.equal(deploys.length, 0);
  const said = sent.map((s) => s.content).join("\n");
  assert.match(said, /no run402 workshop is configured for this room/i);
  assert.ok(!/approve h4-/.test(said));
});

// ── The authority behind the deploy is a real record ─────────────────────

test("the approved deploy runs on a real writeGrant, bound to the refused call and then spent", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  const authority = readAuthority({ stateDir, agent: "spike", eventId: token });
  assert.ok(authority, "the deploy must be authorised by an on-disk record, like every other action");
  assert.equal(authority.kind, "grant");
  assert.deepEqual(authority.capabilities, ["build"]);
  assert.equal(authority.proposalId, token);
  assert.equal(authority.signature, DEPLOY_SIGNATURE, "bound to the exact call that was refused (DD-21)");
  assert.ok(authority.consumedAt, "and spent by the deploy that used it");
});

test("an approval naming an unknown token deploys nothing and is not swallowed", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  sent.length = 0;

  cli.deliver(msg({ id: "e-stale", pubkey: OWNER, content: "@spike approve h4-9zzzz please" }));
  await sup.tick();

  assert.equal(deploys.length, 0, "a token nobody is holding authorises nothing");
  assert.ok(
    !readAuthority({ stateDir, agent: "spike", eventId: "h4-9zzzz" }),
    "and no authority record is written for it",
  );
  // ...and it still reaches the agent as an ordinary message (DD-26's rule that
  // an approval-shaped line naming an unknown token is not an approval).
  assert.ok(sent.length > 0, "the message must not be dropped silently");
});

test("the deploy the node runs is bound to the call the GATE refused, not to a re-typed one", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  // The gate refused a DIFFERENT run402 call from the one this room's config
  // deploys. The authority must carry that call's signature verbatim.
  dropDelegatedBlock(stateDir, { signature: "Bash|run402 up --name whatever -y" });
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  const authority = readAuthority({ stateDir, agent: "spike", eventId: token });
  assert.equal(authority.signature, "Bash|run402 up --name whatever -y");
});

// ── The room hears about a failure honestly ──────────────────────────────

test("a failed deploy is reported in the room, not silently swallowed", async () => {
  const failing = {
    deploys: [],
    async deploy() {
      return { ok: false, error: "gateway rejected the manifest" };
    },
  };
  const { sup, cli, sent, stateDir } = harness({ run402: failing });
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);
  sent.length = 0;

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  assert.match(sent.map((s) => s.content).join("\n"), /gateway rejected the manifest/);
});

test("an empty site directory is reported as nothing to deploy, not as a deploy", async () => {
  const { sup, cli, sent, deploys, stateDir } = harness();
  await sup.start();
  // No buildSite() — the agent never wrote anything.
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);
  sent.length = 0;

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  assert.equal(deploys.length, 0);
  assert.match(sent.map((s) => s.content).join("\n"), /nothing to deploy/i);
});

// ── The deploy is recorded ───────────────────────────────────────────────

test("the deploy is in the audit log the room can query", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  buildSite(stateDir);
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike ship it" }));
  await sup.tick();
  dropDelegatedBlock(stateDir);
  await sup.tick();
  const token = tokenIn(sent.find((s) => /approve h4-/.test(s.content)).content);
  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  const rows = sup.audit.query({ agent: "spike", limit: 50 });
  assert.ok(rows.some((r) => r.kind === "deploy" && /dresstest\.run402\.com/.test(r.detail ?? "")), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.type === "approval" && r.granted), "and so is the approval that released it");
  // And the containment row says WHY, truthfully. A delegated call was not
  // short of a grant and never could be, so "no grant for this turn" would be a
  // false explanation in the record a human queries.
  const contained = rows.find((r) => /contained: Bash: run402/.test(r.detail ?? ""));
  assert.ok(contained, "the delegate refusal must be recorded by the node too");
  assert.match(contained.detail, /run402 is the node's to run and never the agent's/);
  assert.ok(!/no grant for this turn/.test(contained.detail), contained.detail);
});

// ── The trigger: the agent has to know the workshop exists ───────────────

test("a launched agent finds the workshop protocol in its own working directory", async () => {
  // FOUND BY RUNNING IT: with the whole path built and green, the first live
  // run deployed nothing, because spike never reached for run402 — it planned
  // to "publish it with buzz upload file". A caller with no trigger is as
  // unreachable as a module with no caller.
  const { sup, stateDir } = harness();
  await sup.start();

  const guide = readFileSync(path.join(stateDir, "work", "spike", "CLAUDE.md"), "utf8");
  assert.match(guide, /run402 sites deploy-dir \.\/site/, "how publication is requested");
  assert.match(guide, /site/, "which folder is published");
  assert.ok(readdirSync(path.join(stateDir, "work", "spike")).includes("site"), "and the folder exists");
});

test("an agent in a room with no workshop is told nothing about one", async () => {
  const { sup, stateDir } = harness({ workshop: null });
  await sup.start();
  assert.ok(!readdirSync(path.join(stateDir, "work", "spike")).includes("CLAUDE.md"));
});

// ── The bug class itself: a module with no caller ────────────────────────

test("the product actually IMPORTS the workshop module and calls buildAndDeploy", () => {
  // Issue #4 in one assertion. `grep -rn buildAndDeploy src bin` found no caller
  // outside the module, and six green unit tests said the feature worked. This
  // is the fourth module-with-no-caller in this project, so the guard is
  // structural: something outside src/workshop/ must import it AND call it.
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith(".mjs")) files.push(full);
    }
  };
  walk(root);

  const callers = files.filter((file) => {
    if (file.includes(`${path.sep}workshop${path.sep}`)) return false;
    const src = readFileSync(file, "utf8");
    return /from\s+["'][^"']*workshop\/run402\.mjs["']/.test(src) && /buildAndDeploy\s*\(/.test(src);
  });

  assert.ok(
    callers.length > 0,
    "src/workshop/run402.mjs has no caller in the product — that is issue #4, and it is the whole point of this cycle",
  );
});
