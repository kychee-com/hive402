// The cover path, wired (F-11: AC-61, AC-62 at the supervisor level).
//
// A human asks for ANOTHER owner's agent in a room this node watches. The
// node resolves it against the world-readable registry, checks the OWNING
// NODE's relay presence, and posts the taken-message notice as a reply on the
// mention — exactly once, and never when that owner's node is reachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { awayNotice, isAwayNotice } from "../src/listener/notices.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const SMITH = "a".repeat(64); // the foreign agent
const TALNODE = "b".repeat(64); // the node that hosts smith

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });

const smithRecord = {
  kind: 30177,
  pubkey: TALNODE,
  created_at: 100,
  tags: [["d", SMITH]],
  content: JSON.stringify({ name: "smith", parallelism: 1, respond_to: "anyone" }),
};

const nowSec = () => Math.floor(Date.now() / 1000);

// A fresh liveness record for one node — the connection-independent kind-30315
// scheme the heartbeat publishes (see heartbeat.mjs).
const alive = (author) => ({
  kind: 30315,
  pubkey: author,
  created_at: nowSec(),
  content: "online",
  tags: [["d", "hive402-liveness"], ["expiration", String(nowSec() + 300)]],
});

function fakeCli() {
  const sent = [];
  const events = [];
  return {
    sent,
    events,
    deliver(event) {
      events.push(event);
    },
    async getMessages() {
      return events;
    },
    async send(args) {
      const event_id = `sent-${sent.length + 1}`;
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    async setProfile() {
      return { accepted: true };
    },
    async getUser() {
      return null;
    },
    async myChannels() {
      return [{ channel: CHANNEL }];
    },
    async channelMembers() {
      return [{ pubkey: AGENT }, { pubkey: SMITH }, { pubkey: TAL }, { pubkey: NODE }];
    },
  };
}

function harness({ livenessRows = [], registry = [smithRecord], queryFails = false } = {}) {
  const cli = fakeCli();
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-cover-"));
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [
        {
          channel: CHANNEL,
          agents: [
            {
              name: "spike",
              pubkey: AGENT,
              ownerPubkey: OWNER,
              privateKeyRef: "env:TEST_AGENT_KEY",
              research: true,
              build: false,
              crossOwnerAsks: "owner-approves",
              selfInitiated: "asks-owner",
              replyMode: "addressed-only",
            },
          ],
        },
      ],
    },
    stateDir,
    spawn: () => ({ pid: 5555, kill() {} }),
    makeCli: () => cli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    membershipRecheckMs: 0,
    queryEvents: async ({ filters }) => {
      if (queryFails) throw new Error("query door down");
      const f = filters[0] ?? {};
      if (f.kinds?.[0] === 30315) return livenessRows;
      return registry;
    },
    submitEvent: async () => ({ published: true }),
    log: () => {},
  });
  return { sup, cli };
}

const notices = (cli) => cli.sent.filter((s) => isAwayNotice(s.content));

test("a mention of a foreign agent whose node is offline draws the notice, once, on the mention", async () => {
  const { sup, cli } = harness({ livenessRows: [] }); // presence query ok; nobody online
  await sup.start();
  await sup.tick(); // watermark + registry

  cli.deliver({
    id: "3".repeat(64), kind: 9, pubkey: TAL, created_at: nowSec(),
    content: "@smith are you around?", tags: [],
  });
  await sup.tick();

  const posted = notices(cli);
  assert.equal(posted.length, 1, "exactly one notice");
  assert.equal(posted[0].content, awayNotice({ name: "smith" }));
  assert.equal(posted[0].replyTo, "3".repeat(64), "threaded on the specific mention");
  assert.ok(!posted[0].mentions || posted[0].mentions.length === 0, "never mention-shaped");

  await sup.tick();
  assert.equal(notices(cli).length, 1, "still exactly one, ticks later");

  await sup.stop();
});

test("a foreign agent whose node is ONLINE draws nothing (AC-62)", async () => {
  const { sup, cli } = harness({ livenessRows: [alive(TALNODE)] });
  await sup.start();
  await sup.tick();

  cli.deliver({
    id: "4".repeat(64), kind: 9, pubkey: TAL, created_at: nowSec(),
    content: "@smith you there?", tags: [],
  });
  await sup.tick();
  await sup.tick();

  assert.equal(notices(cli).length, 0);
  await sup.stop();
});

test("a mention of OUR OWN agent never draws a notice", async () => {
  const { sup, cli } = harness({ livenessRows: [] });
  await sup.start();
  await sup.tick();

  cli.deliver({
    id: "5".repeat(64), kind: 9, pubkey: TAL, created_at: nowSec(),
    content: "@spike hello!", tags: [],
  });
  await sup.tick();
  await sup.tick();

  assert.equal(notices(cli).length, 0, "our agents are answered, not promised about");
  await sup.stop();
});

test("a registry that cannot be read produces silence, not a crash", async () => {
  const { sup, cli } = harness({ queryFails: true });
  await sup.start();
  await sup.tick();

  cli.deliver({
    id: "6".repeat(64), kind: 9, pubkey: TAL, created_at: nowSec(),
    content: "@smith ping", tags: [],
  });
  await sup.tick();
  await sup.tick();

  assert.equal(notices(cli).length, 0);
  await sup.stop();
});

test("the promise is recorded in the audit log", async () => {
  const { sup, cli } = harness({ livenessRows: [] });
  await sup.start();
  await sup.tick();
  cli.deliver({
    id: "7".repeat(64), kind: 9, pubkey: TAL, created_at: nowSec(),
    content: "@smith ping", tags: [],
  });
  await sup.tick();

  assert.equal(notices(cli).length, 1);
  const rows = sup.audit.query({ agent: "node", limit: 10 });
  assert.ok(
    rows.some((r) => r.kind === "cover-notice"),
    "an audit row names the promise",
  );
  await sup.stop();
});
