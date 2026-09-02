// F-030 (fix cycle 18, FIX-160): the promises are collected BEFORE the first
// backlog drain, so a promised message is delivered as a promise. DD-64.
//
// Collection used to run at the END of the tick and the backlog at the TOP, so
// on the first tick after a restart the backlog always won and `entry.seen`
// silently downgraded a promise to an ordinary backlog wake. Two things ride
// on the promise path and nothing else composes them:
//
//   • the REPLAY NOTE, which is the only thing that tells the room (and the
//     agent) that this message waited rather than just arrived;
//   • AC-65's acknowledge-briefly instruction, which is what stops the agent
//     posting "a full duplicate answer" to a question a human already
//     answered — forbidden by AC-65 in as many words.
//
// The comment defending the late position is about not standing in front of a
// LIVE wake. At startup there is none: the backlog is itself minutes to hours
// old, and the promised messages are older still.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { awayNotice, replayNote } from "../src/listener/notices.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";
import { writeResumePoint } from "../src/node/resumepoint.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";
const TALNODE = "b".repeat(64);

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });
const nowSec = () => Math.floor(Date.now() / 1000);

const ask = ({ id, at, content, pubkey = OWNER }) => ({
  id,
  kind: 9,
  pubkey,
  created_at: at,
  content,
  tags: [["p", AGENT]],
});

const promiseNotice = ({ target, author = TALNODE, name = "spike" }) => ({
  id: `${target.slice(0, 32)}${"e".repeat(32)}`,
  kind: 9,
  pubkey: author,
  created_at: nowSec() - 60,
  content: awayNotice({ name }),
  tags: [["e", target, "", "reply"]],
});

const smithRecord = {
  kind: 30177,
  pubkey: TALNODE,
  created_at: 100,
  tags: [["d", "a".repeat(64)]],
  content: JSON.stringify({ name: "smith", parallelism: 1, respond_to: "anyone" }),
};

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
      return [...events];
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
      return [{ pubkey: AGENT }, { pubkey: TAL }, { pubkey: OWNER }, { pubkey: NODE }];
    },
  };
}

function fakeQuery({ noticeRows = [], originals = [], replies = [], failNotices = false }) {
  return async ({ filters }) => {
    const f = filters[0] ?? {};
    if (f.kinds?.[0] === 30177) return [smithRecord];
    if (f.ids) return originals.filter((o) => f.ids.includes(o.id));
    if (f.kinds?.[0] === 9 && f.authors) {
      if (failNotices) throw new Error("relay query failed");
      return noticeRows;
    }
    if (f.kinds?.[0] === 9 && f["#e"]) return replies;
    return [];
  };
}

function harness({ noticeRows = [], originals = [], replies = [], failNotices = false, stateDir, cli } = {}) {
  const theCli = cli ?? fakeCli();
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), "hive402-f030o-"));
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
    stateDir: dir,
    spawn: () => ({ pid: 6001, exitCode: null, killed: false, kill() {} }),
    makeCli: () => theCli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    queryEvents: fakeQuery({ noticeRows, originals, replies, failNotices }),
    submitEvent: async () => ({ published: true }),
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { sup, cli: theCli, stateDir: dir };
}

const wakes = (cli) =>
  cli.sent.filter((s) => String(s.content ?? "").includes(`${HIVE_MARKER} Waking up agent`));

test("FIX-160: a message that is BOTH promised and inside the backlog window is delivered as a PROMISE, carrying the replay note", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030o-both-"));
  const question = ask({ id: "6".repeat(64), at: nowSec() - 3600, content: "@spike review the doc?" });
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - 4 * 3600 });
  const cli = fakeCli();
  cli.deliver(question);

  const { sup } = harness({
    noticeRows: [promiseNotice({ target: question.id })],
    originals: [question],
    stateDir,
    cli,
  });
  await sup.start();
  await sup.tick();
  await sup.tick();

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "delivered once, by one path");
  assert.ok(
    woken[0].content.includes(replayNote({ answered: false })),
    "and by the PROMISE path — the backlog composes no replay note, so its wake is indistinguishable from a live one",
  );
  await sup.stop();
});

test("FIX-160 (AC-65): a promised message a human already answered gets the acknowledge-briefly instruction, not a full duplicate answer", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030o-ac65-"));
  const question = ask({ id: "8".repeat(64), at: nowSec() - 3600, content: "@spike what is the status?" });
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - 4 * 3600 });
  const cli = fakeCli();
  cli.deliver(question);

  const { sup } = harness({
    noticeRows: [promiseNotice({ target: question.id })],
    originals: [question],
    replies: [
      {
        id: "9".repeat(64),
        kind: 9,
        pubkey: TAL,
        created_at: question.created_at + 120,
        content: "I covered this one already",
        tags: [["e", question.id, "", "reply"]],
      },
    ],
    stateDir,
    cli,
  });
  await sup.start();
  await sup.tick();
  await sup.tick();

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "AC-65: never silence");
  assert.ok(
    woken[0].content.includes("acknowledge it briefly"),
    "AC-65 forbids a full duplicate answer, and this instruction is the only thing that asks for one",
  );
  await sup.stop();
});

test("FIX-160: a collection that FAILS does not silence the backlog — the missed messages still go out that tick", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030o-fail-"));
  const question = ask({ id: "a".repeat(64), at: nowSec() - 3600, content: "@spike are you there?" });
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - 4 * 3600 });
  const cli = fakeCli();
  cli.deliver(question);

  const { sup } = harness({ failNotices: true, stateDir, cli });
  await sup.start();
  await sup.tick();

  assert.equal(
    wakes(cli).length,
    1,
    "FIX-124's failure direction — silence in a room that could not be read — must not be widened into " +
      "a failed promise query silencing the backlog too",
  );
  await sup.stop();
});

test("FIX-160: across BOTH sets the answers still come out oldest-first (AC-63)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030o-order-"));
  // Two promises from three days ago, and one message the node merely missed
  // an hour ago. Oldest first means the two debts, in the order they were
  // said, and only then the recent one.
  const older = ask({ id: "1".repeat(64), at: nowSec() - 3 * 24 * 3600, content: "@spike question one" });
  const old = ask({ id: "2".repeat(64), at: nowSec() - 2 * 24 * 3600, content: "@spike question two" });
  const recent = ask({ id: "3".repeat(64), at: nowSec() - 3600, content: "@spike question three" });

  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - 4 * 3600 });
  const cli = fakeCli();
  cli.deliver(recent);

  const { sup } = harness({
    noticeRows: [promiseNotice({ target: older.id }), promiseNotice({ target: old.id })],
    originals: [older, old],
    stateDir,
    cli,
  });
  await sup.start();
  await sup.tick();
  await sup.tick();

  const said = wakes(cli).map((w) =>
    ["one", "two", "three"].find((n) => w.content.includes(`question ${n}`)),
  );
  assert.deepEqual(said, ["one", "two", "three"], "oldest first, across the promised set and the backlog");
  await sup.stop();
});
