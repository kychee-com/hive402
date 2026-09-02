// AC-66's last clause: what the fallback window drops is REPORTED to the
// owner, never silently swallowed (F-11, aligning the FIX-124 stopgap with
// the spec it now serves).
//
// The count cap already reported its drops. The AGE bound did not: a mention
// that arrived while the node was off but sat older than the window was
// filed as plain history, indistinguishable from the room's back catalogue —
// exactly the silent shape this whole feature exists to end. It stays
// unanswered (that is the window's job); it stops being unREPORTED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { partitionOnResume } from "../src/node/backlog.mjs";
import { writeResumePoint } from "../src/node/resumepoint.mjs";
import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const A = (n) => n.repeat(64);
const AGENTS = [{ name: "spike", pubkey: A("a") }];

const NOW = 1_000_000;
const DAY = 24 * 60 * 60;

const mention = ({ id, at }) => ({
  id,
  kind: 9,
  pubkey: A("7"),
  created_at: at,
  content: "@spike still there?",
  tags: [],
});

test("a mention inside the down-window but past the age bound is counted, not swallowed", () => {
  const { backlog, agedOut, watermark } = partitionOnResume({
    events: [
      mention({ id: A("1"), at: NOW - 2 * DAY }), // while down, but too old
      mention({ id: A("2"), at: NOW - 3600 }), // while down, inside the window
      { id: A("3"), kind: 9, pubkey: A("7"), created_at: NOW - 2 * DAY, content: "no agent named", tags: [] },
    ],
    resumeFrom: NOW - 3 * DAY,
    agents: AGENTS,
    now: NOW,
    maxAgeSec: DAY,
    maxItems: 5,
  });
  assert.equal(backlog.length, 1, "only the in-window mention is answered");
  assert.equal(agedOut, 1, "the aged-out mention is counted");
  assert.ok(watermark.has(A("1")), "…and still filed as history");
});

test("a first run reports nothing aged out — the whole room is history by design", () => {
  const { agedOut } = partitionOnResume({
    events: [mention({ id: A("1"), at: NOW - 2 * DAY })],
    resumeFrom: null,
    agents: AGENTS,
    now: NOW,
    maxAgeSec: DAY,
    maxItems: 5,
  });
  assert.equal(agedOut, 0);
});

test("a short absence has nothing to age out", () => {
  const { agedOut } = partitionOnResume({
    events: [mention({ id: A("1"), at: NOW - 3600 })],
    resumeFrom: NOW - 2 * 3600,
    agents: AGENTS,
    now: NOW,
    maxAgeSec: DAY,
    maxItems: 5,
  });
  assert.equal(agedOut, 0);
});

// ── The owner actually hears about it ──────────────────────────────────────

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";
const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });

test("the aged-out count reaches the owner's log on start", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-aged-"));
  // The node last got to three days ago; a mention arrived two days ago.
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec - 3 * DAY });
  const history = [
    { id: A("4"), kind: 9, pubkey: TAL, created_at: nowSec - 2 * DAY, content: "@spike hello?", tags: [] },
  ];
  const logged = [];
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
              name: "spike", pubkey: AGENT, ownerPubkey: OWNER,
              privateKeyRef: "env:TEST_AGENT_KEY", research: true, build: false,
              crossOwnerAsks: "owner-approves", selfInitiated: "asks-owner",
              replyMode: "addressed-only",
            },
          ],
        },
      ],
    },
    stateDir,
    spawn: () => ({ pid: 7001, kill() {} }),
    makeCli: () => ({
      async getMessages() {
        return history;
      },
      async send(args) {
        return { accepted: true, event_id: `sent-x` };
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
        return [{ pubkey: AGENT }, { pubkey: TAL }];
      },
    }),
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    membershipRecheckMs: 0,
    queryEvents: async () => [],
    submitEvent: async () => ({ published: true }),
    log: (line) => logged.push(String(line)),
  });

  await sup.start();
  await sup.tick();
  assert.ok(
    logged.some((l) => /older than the backlog window/.test(l) && /1 message/.test(l)),
    `the owner is told what the age bound dropped; got:\n${logged.join("\n")}`,
  );
  await sup.stop();
});
