// The promise kept (F-11: AC-63, AC-64, AC-65 at the supervisor level).
//
// On start the node collects the taken-message notices trusted nodes posted
// for ITS agents, joins each to the message it pinned — however old — and
// answers it through the SAME policy path as live traffic. Count-capped with
// the overflow named in the room; a thread the agent already answered is
// complete; one a human answered still gets the acknowledge-briefly
// instruction; and a restart never replays a promise twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority } from "../src/runtime/grants.mjs";
import { awayNotice, isAwayNotice, replayNote } from "../src/listener/notices.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const SMITH = "a".repeat(64);
const TALNODE = "b".repeat(64);

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });
const nowSec = () => Math.floor(Date.now() / 1000);

const smithRecord = {
  kind: 30177,
  pubkey: TALNODE,
  created_at: 100,
  tags: [["d", SMITH]],
  content: JSON.stringify({ name: "smith", parallelism: 1, respond_to: "anyone" }),
};

// A three-day-old ask: far outside the 24-hour catch-up window, which is the
// point — a promise has no age bound.
const original = ({ id = "3".repeat(64), at = nowSec() - 3 * 24 * 3600, content = "@spike can you review the doc?" } = {}) => ({
  id,
  kind: 9,
  pubkey: TAL,
  created_at: at,
  content,
  tags: [["p", AGENT]],
});

const promiseNotice = ({ target = "3".repeat(64), author = TALNODE, name = "spike", at = nowSec() - 3 * 24 * 3600 + 60 } = {}) => ({
  id: "e".repeat(64),
  kind: 9,
  pubkey: author,
  created_at: at,
  content: awayNotice({ name }),
  tags: [["e", target, "", "reply"]],
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

// Route /query calls by filter shape, the way the relay would.
function fakeQuery({ registry = [smithRecord], noticeRows = [], originals = [], replies = [] }) {
  return async ({ filters }) => {
    const f = filters[0] ?? {};
    if (f.kinds?.[0] === 30177) return registry;
    if (f.ids) return originals.filter((o) => f.ids.includes(o.id));
    if (f.kinds?.[0] === 9 && f.authors) return noticeRows;
    if (f.kinds?.[0] === 9 && f["#e"]) return replies;
    return [];
  };
}

function harness({ noticeRows = [], originals = [], replies = [], cover, stateDir, cli } = {}) {
  const theCli = cli ?? fakeCli();
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), "hive402-promise-"));
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
    spawn: () => ({ pid: 6001, kill() {} }),
    makeCli: () => theCli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    membershipRecheckMs: 0,
    queryEvents: fakeQuery({ noticeRows, originals, replies }),
    submitEvent: async () => ({ published: true }),
    log: () => {},
  });
  return { sup, cli: theCli, stateDir: dir };
}

const wakes = (cli) =>
  cli.sent.filter((s) => String(s.content ?? "").includes(`${HIVE_MARKER} Waking up agent`));

test("a promised three-day-old ask is answered on start, in its thread, through policy", async () => {
  const ask = original();
  const { sup, cli, stateDir } = harness({
    noticeRows: [promiseNotice()],
    originals: [ask],
  });
  await sup.start();
  await sup.tick(); // collects at the tick's end…
  await sup.tick(); // …and keeps the promises at the top of the next

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "the promise produced a wake");
  assert.equal(woken[0].replyTo, ask.id, "in the original conversation");
  assert.ok(woken[0].content.includes("can you review the doc?"), "carrying the ask");
  assert.ok(
    woken[0].content.includes(replayNote({ answered: false })),
    "told it waited, told to read the thread",
  );

  // DD-9: the replayed turn went through the SAME authority path — TAL is not
  // spike's owner, so the turn holds nothing.
  const record = readAuthority({ stateDir, agent: "spike", eventId: woken[0].event_id });
  assert.equal(record?.kind, "withheld");

  await sup.stop();
});

test("a promise is kept once, not once per restart", async () => {
  const ask = original();
  const first = harness({ noticeRows: [promiseNotice()], originals: [ask] });
  await first.sup.start();
  await first.sup.tick();
  await first.sup.tick();
  assert.equal(wakes(first.cli).length, 1);
  await first.sup.stop();

  const second = harness({
    noticeRows: [promiseNotice()],
    originals: [ask],
    stateDir: first.stateDir,
    cli: first.cli,
  });
  await second.sup.start();
  await second.sup.tick();
  await second.sup.tick();
  assert.equal(wakes(second.cli).length, 1, "no second wake for the same promise");
  await second.sup.stop();
});

test("a thread the agent already answered is complete — no replay", async () => {
  const ask = original();
  const { sup, cli } = harness({
    noticeRows: [promiseNotice()],
    originals: [ask],
    replies: [
      {
        id: "f".repeat(64), kind: 9, pubkey: AGENT, created_at: ask.created_at + 120,
        content: "done!", tags: [["e", ask.id, "", "reply"]],
      },
    ],
  });
  await sup.start();
  await sup.tick(); // collects at the tick's end…
  await sup.tick(); // …and keeps the promises at the top of the next
  assert.equal(wakes(cli).length, 0);
  await sup.stop();
});

test("a thread a HUMAN answered is still replayed, with the acknowledge-briefly instruction", async () => {
  const ask = original();
  const { sup, cli } = harness({
    noticeRows: [promiseNotice()],
    originals: [ask],
    replies: [
      {
        id: "f".repeat(64), kind: 9, pubkey: OWNER, created_at: ask.created_at + 120,
        content: "I covered this one already", tags: [["e", ask.id, "", "reply"]],
      },
    ],
  });
  await sup.start();
  await sup.tick(); // collects at the tick's end…
  await sup.tick(); // …and keeps the promises at the top of the next

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "AC-65: never silence");
  assert.ok(
    woken[0].content.includes("acknowledge it briefly"),
    "the wake carries the acknowledge-briefly instruction",
  );
  await sup.stop();
});

test("the cap keeps the newest, replays oldest-first, and names the dropped in the room", async () => {
  const base = nowSec() - 3 * 24 * 3600;
  const asks = [1, 2, 3].map((i) =>
    original({ id: String(i).repeat(64), at: base + i * 600, content: `@spike question ${i}` }),
  );
  const { sup, cli } = harness({
    noticeRows: asks.map((a) => ({ ...promiseNotice({ target: a.id }), id: `${a.id.slice(0, 32)}${"e".repeat(32)}` })),
    originals: asks,
    cover: { replayCapPerAgent: 2 },
  });
  await sup.start();
  await sup.tick(); // collects at the tick's end…
  await sup.tick(); // …and keeps the promises at the top of the next

  const woken = wakes(cli);
  assert.equal(woken.length, 2, "capped at two");
  assert.ok(woken[0].content.includes("question 2"), "oldest of the kept first");
  assert.ok(woken[1].content.includes("question 3"));

  const overflow = cli.sent.find((s) => String(s.content).includes("more messages were waiting"));
  assert.ok(overflow, "the overflow is named in the room, never silent");
  assert.equal(
    overflow.content,
    `${HIVE_MARKER} 1 more messages were waiting for spike. It answered the most recent 2. Ask again if one of the others still matters.`,
  );
  await sup.stop();
});

test("a forged promise from a non-node author replays nothing", async () => {
  const ask = original();
  const { sup, cli } = harness({
    noticeRows: [promiseNotice({ author: TAL })],
    originals: [ask],
  });
  await sup.start();
  await sup.tick(); // collects at the tick's end…
  await sup.tick(); // …and keeps the promises at the top of the next
  assert.equal(wakes(cli).length, 0);
  await sup.stop();
});

test("a promise pinning a message that never asked replays nothing", async () => {
  const bystander = original({ content: "just chatting about spikes in the data" });
  const { sup, cli } = harness({
    noticeRows: [promiseNotice()],
    originals: [bystander],
  });
  await sup.start();
  await sup.tick(); // collects at the tick's end…
  await sup.tick(); // …and keeps the promises at the top of the next
  assert.equal(wakes(cli).length, 0);
  await sup.stop();
});

test("FIX-143: a REPLAYED wake records no answer-check receipt, so a promise is kept once", async () => {
  // The receipt FIX-143 puts on every relayed wake must not land on this one.
  // A replay is a RE-delivery of a message the room was already promised an
  // answer to; a receipt here would relay it a second time under a different
  // name, against FIX-132's one-replay-per-promise posture. The clock has to
  // MOVE or the grace window is never crossed and this is green either way.
  const ask = original();
  const { sup, cli } = harness({ noticeRows: [promiseNotice()], originals: [ask] });
  await sup.start();
  await sup.tick();
  await sup.tick();
  assert.equal(wakes(cli).length, 1, "precondition: the promise was replayed once");

  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    // Twenty minutes, past the 600s handoff grace, with the agent silent.
    for (let i = 0; i < 20; i += 1) {
      clock += 60_000;
      await sup.tick();
    }
  } finally {
    Date.now = realNow;
  }

  assert.equal(wakes(cli).length, 1, "and it stays kept once, however long the node runs");
  await sup.stop();
});

test("no notice anywhere means the ordinary catch-up window is all there is", async () => {
  const { sup, cli } = harness({ noticeRows: [], originals: [original()] });
  await sup.start();
  await sup.tick(); // collects at the tick's end…
  await sup.tick(); // …and keeps the promises at the top of the next
  assert.equal(wakes(cli).length, 0, "nothing was promised, nothing is replayed from here");
  assert.equal(cli.sent.filter((s) => isAwayNotice(s.content)).length, 0);
  await sup.stop();
});
