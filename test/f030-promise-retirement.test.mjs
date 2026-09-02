// F-030 (fix cycle 18, FIX-159): a promise is retired when the node actually
// DELIVERED it, never when it merely tried. DD-64.
//
// Three places treated "we handed this to `dispatcher.handle`" as "the promise
// is kept", and none of them asked whether anything was published:
//
//   1. `markDispatched` ran unconditionally after `handle()` returned,
//      whatever it returned;
//   2. the promise pass marked on the strength of `entry.seen`, which records
//      dispatch ATTEMPTS, not deliveries — so another path's silently forked
//      dispatch retired the promise too;
//   3. the AC-64 overflow drop marked even when the notice that was supposed
//      to name it in the room never posted.
//
// The mark is on DISK and permanent. That is what made F-030 unrecoverable:
// the only net (the in-memory `HandoffTracker`) is discarded by the very
// restart that keeps the mark.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { awayNotice } from "../src/listener/notices.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";
import { isDispatched } from "../src/node/promises.mjs";
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
const ASK_ID = "3".repeat(64);

const ask = ({ id = ASK_ID, at = nowSec() - 3 * 24 * 3600, content = "@spike review the doc?", pubkey = OWNER } = {}) => ({
  id,
  kind: 9,
  pubkey,
  created_at: at,
  content,
  tags: [["p", AGENT]],
});

const promiseNotice = ({ target = ASK_ID, author = TALNODE, name = "spike" } = {}) => ({
  id: `${target.slice(0, 32)}${"e".repeat(32)}`,
  kind: 9,
  pubkey: author,
  created_at: nowSec() - 3 * 24 * 3600 + 60,
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

const isWake = (content) => String(content ?? "").includes(`${HIVE_MARKER} Waking up agent`);

// A relay that can be told to refuse specific publishes. `refuse` is asked
// about every send, so a test can fail the wake and let the notices through,
// or the other way round.
function fakeCli({ refuse = () => false } = {}) {
  const sent = [];
  const refused = [];
  const events = [];
  return {
    sent,
    refused,
    events,
    deliver(event) {
      events.push(event);
    },
    async getMessages() {
      return [...events];
    },
    async send(args) {
      if (refuse(args)) {
        refused.push(args);
        throw new Error("relay refused the publish");
      }
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

function fakeQuery({ noticeRows = [], originals = [], replies = [], failNoticeQueries = 0 }) {
  let noticeFailures = failNoticeQueries;
  return async ({ filters }) => {
    const f = filters[0] ?? {};
    if (f.kinds?.[0] === 30177) return [smithRecord];
    if (f.ids) return originals.filter((o) => f.ids.includes(o.id));
    if (f.kinds?.[0] === 9 && f.authors) {
      if (noticeFailures > 0) {
        noticeFailures -= 1;
        throw new Error("relay query failed");
      }
      return noticeRows;
    }
    if (f.kinds?.[0] === 9 && f["#e"]) return replies;
    return [];
  };
}

function harness({
  noticeRows = [],
  originals = [],
  replies = [],
  failNoticeQueries = 0,
  stateDir,
  cli,
  cover,
} = {}) {
  const theCli = cli ?? fakeCli();
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), "hive402-f030r-"));
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      ...(cover ? { cover } : {}),
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
    queryEvents: fakeQuery({ noticeRows, originals, replies, failNoticeQueries }),
    submitEvent: async () => ({ published: true }),
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { sup, cli: theCli, stateDir: dir };
}

const wakes = (cli) => cli.sent.filter((s) => isWake(s.content));

// ── The mark follows the delivery ─────────────────────────────────────────

test("FIX-159: a promise whose wake could not be published is NOT retired, and the next start offers it again", async () => {
  const question = ask();
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030r-unpub-"));

  // The relay takes the node's other lines and refuses the wake — the honest
  // shape of "the dispatch published nothing".
  const deaf = fakeCli({ refuse: (args) => isWake(args.content) });
  const first = harness({
    noticeRows: [promiseNotice()],
    originals: [question],
    stateDir,
    cli: deaf,
  });
  await first.sup.start();
  await first.sup.tick();
  await first.sup.tick();
  assert.equal(wakes(deaf).length, 0, "nothing reached the room");
  assert.ok(deaf.refused.some((s) => isWake(s.content)), "and the wake is what was refused");
  assert.equal(
    isDispatched({ stateDir, id: question.id, agent: "spike" }),
    false,
    "a promise nobody was told about is still owed",
  );
  await first.sup.stop();

  // The machine restarts and the relay is well again.
  const working = fakeCli();
  const second = harness({
    noticeRows: [promiseNotice()],
    originals: [question],
    stateDir,
    cli: working,
  });
  await second.sup.start();
  await second.sup.tick();
  await second.sup.tick();
  assert.equal(wakes(working).length, 1, "the next collection offers it again, and it is kept");
  assert.equal(
    isDispatched({ stateDir, id: question.id, agent: "spike" }),
    true,
    "and only NOW is it retired",
  );
  await second.sup.stop();
});

test("FIX-159: a promise that WAS published is retired exactly once — a second start does not replay it", async () => {
  const question = ask();
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030r-once-"));
  const cli = fakeCli();

  const first = harness({ noticeRows: [promiseNotice()], originals: [question], stateDir, cli });
  await first.sup.start();
  await first.sup.tick();
  await first.sup.tick();
  assert.equal(wakes(cli).length, 1);
  assert.equal(isDispatched({ stateDir, id: question.id, agent: "spike" }), true);
  await first.sup.stop();

  const second = harness({ noticeRows: [promiseNotice()], originals: [question], stateDir, cli });
  await second.sup.start();
  await second.sup.tick();
  await second.sup.tick();
  assert.equal(wakes(cli).length, 1, "FIX-132's posture, unchanged: one replay per promise, ever");
  await second.sup.stop();
});

test("FIX-159: the `seen` short-circuit no longer retires a promise on another path's behalf", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030r-seen-"));
  const question = ask({ id: "7".repeat(64), at: nowSec() - 3600 });

  // The node was off for four hours, so the ask is in the backlog too. The
  // relay refuses every wake, so whichever path reaches it publishes nothing.
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - 4 * 3600 });
  const deaf = fakeCli({ refuse: (args) => isWake(args.content) });
  deaf.deliver(question);

  // The first collection fails, so the BACKLOG gets there first — which is
  // exactly the ordering that let `entry.seen` retire a promise nobody kept.
  const { sup } = harness({
    noticeRows: [promiseNotice({ target: question.id })],
    originals: [question],
    failNoticeQueries: 1,
    stateDir,
    cli: deaf,
  });
  await sup.start();
  await sup.tick();
  await sup.tick();
  await sup.tick();

  assert.equal(wakes(deaf).length, 0, "the backlog dispatch published nothing");
  assert.equal(
    isDispatched({ stateDir, id: question.id, agent: "spike" }),
    false,
    "`entry.seen` records attempts, not deliveries — it may not retire a promise",
  );
  await sup.stop();
});

// ── The bound: a promise that can never produce a wake is not re-collected
//    forever ───────────────────────────────────────────────────────────────

test("FIX-159: a promised message the dispatcher has nothing at all to do with IS retired, so the retry is bounded", async () => {
  // The node's own event. `Dispatcher.handle` drops it at the front door and
  // returns no effects — a genuine nothing-to-deliver rather than a swallow,
  // and re-offering it every restart would be a promise that can never be
  // kept and never expires.
  const question = ask({ pubkey: NODE });
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030r-none-"));
  const cli = fakeCli();
  const { sup } = harness({
    noticeRows: [promiseNotice()],
    originals: [question],
    stateDir,
    cli,
  });
  await sup.start();
  await sup.tick();
  await sup.tick();
  assert.equal(wakes(cli).length, 0, "there was nothing to wake anyone for");
  assert.equal(
    isDispatched({ stateDir, id: question.id, agent: "spike" }),
    true,
    "and it is retired rather than re-collected forever",
  );
  await sup.stop();
});

// ── AC-64: the one case where retiring an undelivered promise is right ────

test("FIX-159: an AC-64 overflow drop still retires the promises it named in the room", async () => {
  const base = nowSec() - 3 * 24 * 3600;
  const asks = [1, 2, 3].map((i) =>
    ask({ id: String(i).repeat(64), at: base + i * 600, content: `@spike question ${i}` }),
  );
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030r-cap-"));
  const cli = fakeCli();
  const { sup } = harness({
    noticeRows: asks.map((a) => promiseNotice({ target: a.id })),
    originals: asks,
    cover: { replayCapPerAgent: 2 },
    stateDir,
    cli,
  });
  await sup.start();
  await sup.tick();
  await sup.tick();

  const overflow = cli.sent.find((s) => String(s.content).includes("more messages were waiting"));
  assert.ok(overflow, "AC-64: the drop is named in the room, never silent");
  assert.equal(
    isDispatched({ stateDir, id: asks[0].id, agent: "spike" }),
    true,
    "the dropped promise is retired, BECAUSE the room was told about it",
  );
  assert.equal(wakes(cli).length, 2, "and the two kept promises were answered");
  await sup.stop();
});

test("FIX-159: an overflow notice that could not be posted does NOT retire the promises it never named", async () => {
  const base = nowSec() - 3 * 24 * 3600;
  const asks = [1, 2, 3].map((i) =>
    ask({ id: String(i).repeat(64), at: base + i * 600, content: `@spike question ${i}` }),
  );
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030r-capfail-"));
  // The relay takes wakes but refuses the overflow notice.
  const cli = fakeCli({ refuse: (args) => String(args.content ?? "").includes("more messages were waiting") });
  const { sup } = harness({
    noticeRows: asks.map((a) => promiseNotice({ target: a.id })),
    originals: asks,
    cover: { replayCapPerAgent: 2 },
    stateDir,
    cli,
  });
  await sup.start();
  await sup.tick();
  await sup.tick();

  assert.equal(
    isDispatched({ stateDir, id: asks[0].id, agent: "spike" }),
    false,
    "a drop the room was never told about is still owed (DD-64)",
  );
  await sup.stop();
});
