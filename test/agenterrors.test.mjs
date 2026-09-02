// FIX-129 — the agent failed and nobody said so.
//
// Barry asked smith a question and got NOTHING back. Not a refusal, not an
// error, not a "working on it". `hive402 doctor` was green throughout, and it
// was telling the truth: the node saw the message, published the wake, spawned
// the harness, and the harness connected, subscribed and set presence online.
//
// The model backend then refused to log in, and said so in `smith.log`:
//
//   agent_returned outcome="error"
//   error=Agent reported error (code -32603): Internal error:
//         Failed to authenticate: OAuth session expired and could not be refreshed
//
// That line sat there for over an hour. Nothing surfaced it, so the room saw a
// silent agent and the operator saw a healthy node. Same shape as the bug
// FIX-124 fixed, through a different door: a question with no answer and no
// explanation.

import { test } from "node:test";
import assert from "node:assert/strict";

import { lastAgentTurn, describeAgentFailure, describeStaleFailure } from "../src/node/agenterrors.mjs";

// The real line, verbatim from Barry's machine, colour codes and all — because
// this parses a third party's log and a hand-tidied fixture would prove nothing
// about the format actually written to disk.
const REAL_FAILURE =
  '\u001b[2m2026-08-27T15:15:15.191014Z\u001b[0m \u001b[33m WARN\u001b[0m \u001b[2mbuzz_acp\u001b[0m\u001b[2m:\u001b[0m ' +
  'agent_returned (application error — pipe intact) \u001b[3magent\u001b[0m\u001b[2m=\u001b[0m0 ' +
  '\u001b[3moutcome\u001b[0m\u001b[2m=\u001b[0m"error" \u001b[3merror\u001b[0m\u001b[2m=\u001b[0m' +
  "Agent reported error (code -32603): Internal error: Failed to authenticate: " +
  "OAuth session expired and could not be refreshed";

test("the real failure line from Barry's machine is read as a failure", () => {
  const turn = lastAgentTurn(REAL_FAILURE);
  assert.equal(turn.failed, true);
  assert.equal(turn.outcome, "error");
  assert.match(turn.message, /OAuth session expired/);
});

test("an expired login is named, with the command that fixes it", () => {
  // The whole point. "OAuth session expired and could not be refreshed" is the
  // agent's words and they are accurate, but they do not tell an owner to run
  // `claude`. That is the gap between a log and a diagnosis.
  const said = describeAgentFailure({ agent: "smith", turn: lastAgentTurn(REAL_FAILURE) });
  assert.match(said.headline, /smith.*FAILED/);
  assert.match(said.headline, /will not answer/i, "and says what it means for the room");
  assert.match(said.detail, /claude/, "the command to run");
  assert.match(said.detail, /hive402 down|hive402 up/, "and that the node must be restarted after");
});

test("a successful last turn is not news", () => {
  // An error from three days ago followed by a working turn is history.
  // Reporting it would train the operator to ignore this line, which is how a
  // real failure gets missed.
  const log = [REAL_FAILURE, '2026-08-27T16:00:00Z INFO buzz_acp: agent_returned outcome="ok"'].join("\n");
  const turn = lastAgentTurn(log);
  assert.equal(turn.failed, false);
  assert.equal(describeAgentFailure({ agent: "smith", turn }), null);
});

test("the LAST turn is the one that counts, not the first", () => {
  const log = ['2026-08-27T10:00:00Z agent_returned outcome="ok"', REAL_FAILURE].join("\n");
  assert.equal(lastAgentTurn(log).failed, true);
});

test("an agent that has never completed a turn reports nothing", () => {
  // A freshly launched harness has no verdict yet, and inventing one would make
  // every first start look broken.
  assert.equal(lastAgentTurn("buzz-acp starting: relay=wss://…\nconnected to relay"), null);
  assert.equal(describeAgentFailure({ agent: "smith", turn: null }), null);
});

// ── Errors this does not recognise ────────────────────────────────────────

test("an unrecognised error is shown in the agent's OWN words", () => {
  // This parses somebody else's log format, which will change. A wrong
  // explanation is worse than a raw one, so nothing is guessed at.
  const odd = 'agent_returned outcome="error" error=the flux capacitor came loose';
  const said = describeAgentFailure({ agent: "smith", turn: lastAgentTurn(odd) });
  assert.match(said.detail, /flux capacitor/);
});

test("a failure with no reason at all still says the turn failed", () => {
  const bare = 'agent_returned outcome="error"';
  const said = describeAgentFailure({ agent: "smith", turn: lastAgentTurn(bare) });
  assert.ok(said, "silence about a failed turn is the bug being fixed");
  assert.match(said.detail, /no reason/i);
});

test("a rate limit and a missing adapter each get their own remedy", () => {
  const cases = [
    ['agent_returned outcome="error" error=429 rate limit exceeded', /rate limit/i],
    ['agent_returned outcome="error" error=spawn node ENOENT', /tools\.adapter/],
  ];
  for (const [line, expected] of cases) {
    const said = describeAgentFailure({ agent: "smith", turn: lastAgentTurn(line) });
    assert.match(said.detail, expected, line);
  }
});

// ── A failure the agent has RESTARTED since ───────────────────────────────
//
// CAUGHT AN HOUR AFTER SHIPPING, on the machine this was written for. Barry
// fixed his login, the node restarted, smith came up healthy — and `doctor`
// still said "it will not answer until this is fixed", because the newest turn
// RESULT in the log was still the old failure. smith had not failed again; it
// had not been asked.
//
// The room notice would have fired on his very next message, telling him an
// agent that was working could not answer. A false alarm is not a smaller
// version of a true one: it teaches the reader to ignore the next real one,
// which is the exact thing FIX-129 and FIX-130 exist to prevent.

const RESTARTED_SINCE = [
  REAL_FAILURE,
  "2026-08-27T18:40:00.000000Z  INFO buzz_acp: buzz-acp starting: relay=wss://… agents=1",
  "2026-08-27T18:40:01.000000Z  INFO buzz_acp: connected to relay",
].join("\n");

test("a restart after the failure is noticed", () => {
  assert.equal(lastAgentTurn(RESTARTED_SINCE).restarted, true);
  assert.equal(lastAgentTurn(REAL_FAILURE).restarted, false);
});

test("a POOL that came back counts too, not just a whole harness restart", () => {
  // The node runs buzz-acp with BUZZ_ACP_LAZY_POOL=true, so an idle pool is torn
  // down and brought back WITHOUT `buzz-acp starting` ever appearing again.
  // Watching only for a restart would leave a pre-teardown failure reading as
  // live forever, and the room would be told the agent was broken every time
  // somebody asked it something.
  //
  // These two lines are what a real successful turn wrote on Barry's machine at
  // 19:09 — there is no "turn succeeded" marker to look for, because
  // `agent_returned` is written on failure only.
  for (const marker of [
    "2026-08-27T19:09:35.584965Z  INFO buzz_acp: agent initialized agent=0 name=\"…\"",
    "2026-08-27T19:09:35.584991Z  INFO buzz_acp: agent_pool_ready agents=1",
  ]) {
    const turn = lastAgentTurn([REAL_FAILURE, marker].join("\n"));
    assert.equal(turn.restarted, true, marker);
    assert.equal(describeAgentFailure({ agent: "smith", turn }), null, `must not warn after: ${marker}`);
  }
});

test("the ROOM is never told an agent is broken when it has simply not been asked", () => {
  assert.equal(describeAgentFailure({ agent: "smith", turn: lastAgentTurn(RESTARTED_SINCE) }), null);
});

test("doctor still MENTIONS it, because the last thing that happened is worth knowing", () => {
  const said = describeStaleFailure({ agent: "smith", turn: lastAgentTurn(RESTARTED_SINCE) });
  assert.match(said, /last turn failed/i);
  assert.match(said, /restarted since/i, "and why it is not a current failure");
  assert.match(said, /not been asked/i);
});

test("a failure with NO restart after it is still a live failure", () => {
  // The guard must not swallow the real case: this is the state Barry was
  // actually in for an hour, and it has to keep reporting.
  assert.ok(describeAgentFailure({ agent: "smith", turn: lastAgentTurn(REAL_FAILURE) }));
  assert.equal(describeStaleFailure({ agent: "smith", turn: lastAgentTurn(REAL_FAILURE) }), null);
});

test("a third party's error string cannot flood the report", () => {
  const huge = `agent_returned outcome="error" error=${"x".repeat(5000)}`;
  const turn = lastAgentTurn(huge);
  assert.ok(turn.message.length <= 300, `capped, got ${turn.message.length}`);
});

// ── FIX-130: the ROOM is told, not just the operator ──────────────────────
//
// Barry asked smith twice and got silence. Then he saw Buzz's own agent handle
// the identical situation properly, in the thread where he had asked:
//
//   Fizz needs configuration
//   complete Claude Code authentication by running the Claude CLI
//
// Buzz tells the room. hive402 knew the same fact, from the same log, and told
// nobody — FIX-129 surfaced it in `doctor`, which helps the operator and does
// nothing for the person waiting in the room.
//
// The node cannot answer FOR the agent and must not try. It can stop the room
// waiting on something that is not coming.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

function roomWithBrokenAgent({ agentLog }) {
  const stateDir = mkdtempSync(nodePath.join(tmpdir(), "hive402-broken-"));
  mkdirSync(nodePath.join(stateDir, "logs"), { recursive: true });
  if (agentLog !== null) writeFileSync(nodePath.join(stateDir, "logs", "spike.log"), agentLog);

  const sent = [];
  const events = [];
  const cli = {
    sent,
    deliver: (e) => events.push(e),
    getMessages: async () => [...events],
    send: async (args) => {
      sent.push(args);
      return { accepted: true, event_id: `sent-${sent.length}` };
    },
    setProfile: async () => ({ accepted: true }),
    getUser: async ({ pubkey, name }) => {
      if (name) return { pubkey: AGENT, display_name: name };
      if (pubkey === AGENT) return { pubkey, display_name: "spike" };
      return { pubkey, display_name: "Tal" };
    },
  };

  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:K" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\a.js", extraDirs: [] },
      rooms: [
        {
          channel: CHANNEL,
          agents: [
            {
              name: "spike",
              pubkey: AGENT,
              ownerPubkey: OWNER,
              privateKeyRef: "env:K",
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
    // Never "running", so every message produces a relayed wake — the path the
    // notice hangs off.
    spawn: () => ({ pid: 4242, exitCode: 0, killed: false, kill() {} }),
    makeCli: () => cli,
    readAttestation: (a) => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: a.pubkey }),
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { sup, cli };
}

const ask = (over = {}) => ({
  id: "q1",
  kind: 9,
  pubkey: TAL,
  created_at: Math.floor(Date.now() / 1000),
  content: "@spike are you there?",
  tags: [],
  ...over,
});

const notices = (cli) => cli.sent.filter((s) => /cannot answer right now/i.test(s.content ?? ""));

test("a broken agent's room is TOLD, in the thread where it was asked", async () => {
  const { sup, cli } = roomWithBrokenAgent({ agentLog: REAL_FAILURE });
  await sup.start();
  cli.deliver(ask({ tags: [["e", "a".repeat(64), "", "reply"]] }));
  await sup.tick();

  const [notice] = notices(cli);
  assert.ok(notice, `the room must be told, got: ${JSON.stringify(cli.sent.map((s) => s.content))}`);
  assert.match(notice.content, /spike cannot answer/i);
  assert.match(notice.content, /claude/i, "and why, in terms somebody can act on");
  assert.equal(notice.replyTo, "a".repeat(64), "in the thread the question was asked in");
});

test("the notice is the NODE's line, so a human cannot forge one", async () => {
  const { sup, cli } = roomWithBrokenAgent({ agentLog: REAL_FAILURE });
  await sup.start();
  cli.deliver(ask());
  await sup.tick();
  assert.match(notices(cli)[0].content, /^\[hive402\]/);
});

test("ONE notice per failure, however many times the room asks", async () => {
  // A red banner under every message would be worse than the silence: the
  // notice becomes the noise, and the next real one is ignored.
  const { sup, cli } = roomWithBrokenAgent({ agentLog: REAL_FAILURE });
  await sup.start();
  for (const id of ["q1", "q2", "q3"]) {
    cli.deliver(ask({ id }));
    await sup.tick();
  }
  assert.equal(notices(cli).length, 1, "said once, not once per message");
});

test("a WORKING agent's room is told nothing", async () => {
  const { sup, cli } = roomWithBrokenAgent({
    agentLog: `${REAL_FAILURE}\n2026-08-27T16:00:00Z agent_returned outcome="ok"`,
  });
  await sup.start();
  cli.deliver(ask());
  await sup.tick();
  assert.deepEqual(notices(cli), []);
});

test("an agent that has never run is not called broken", async () => {
  // A first start has no verdict yet, and announcing one would greet every new
  // agent with a failure notice.
  const { sup, cli } = roomWithBrokenAgent({ agentLog: null });
  await sup.start();
  cli.deliver(ask());
  await sup.tick();
  assert.deepEqual(notices(cli), []);
});

test("the wake is still published — the notice never replaces it", async () => {
  // The agent may recover between the log line and the turn. Suppressing the
  // wake would turn a diagnosis into a second failure.
  const { sup, cli } = roomWithBrokenAgent({ agentLog: REAL_FAILURE });
  await sup.start();
  cli.deliver(ask());
  await sup.tick();
  assert.ok(
    cli.sent.some((s) => (s.mentions ?? []).includes(AGENT)),
    "the wake must still go out",
  );
});
