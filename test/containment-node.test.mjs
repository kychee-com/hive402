// The node's half of per-turn containment (DD-15/DD-16, fix cycle 2).
//
// dispatch-grants.test.mjs proves the DECISIONS. This proves they reach disk,
// that the runtime gate's refusals get back to the node, and that the audit log
// is one record with two writers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { AuditLog } from "../src/audit/log.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority, readGrant } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });

const config = () => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:/Buzz", nodeDir: "C:/node", adapter: "C:/adapter.js", extraDirs: [] },
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
});

function harness() {
  const events = [];
  const sent = [];
  const cli = {
    deliver: (e) => events.push(e),
    async getMessages() { return events; },
    // The real relay answers a send with the id of the event it created, and
    // that id is load-bearing now: a wake's authority is keyed by it (DD-20).
    // The fake used to return `{accepted:true}` alone, which quietly modelled a
    // relay that does not exist.
    async send(args) {
      const event_id = `sent-${sent.length + 1}`.padEnd(64, "0");
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    async setProfile() { return { accepted: true }; },
    async getUser({ pubkey }) { return pubkey === AGENT ? { pubkey: AGENT, display_name: "spike" } : null; },
  };
  const spawned = [];
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-contain-"));
  const sup = new Supervisor({
    config: config(),
    stateDir,
    spawn: (command, args, opts) => {
      spawned.push({ command, args, opts });
      return { pid: 4242, killed: false, kill() { this.killed = true; } };
    },
    makeCli: () => cli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
  });
  return { sup, cli, sent, spawned, stateDir };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });

// A relayed wake triggers the turn it authorises, so its authority is keyed by
// the wake's own event id — not by the requester's message.
const authorityForLastWake = (stateDir, sent) =>
  readAuthority({ stateDir, agent: "spike", eventId: sent[sent.length - 1]?.event_id });

// The verbatim F-007 message: no "research", "look up", "search", "check" or "find".
const F007 =
  "@spike random one for you, no pressure either way - what's the top story " +
  "headline on Hacker News' front page at this moment?";

// ── Grants reach disk, in the right order ──────────────────────────────────

test("an agent is contained from the moment it launches, before any message arrives", async () => {
  // REGRESSION: without this, the window between "process is up" and "the node
  // has seen a first message" is a window with no record on disk at all, and
  // the gate's wait-then-deny would be the only thing standing there.
  const { sup, stateDir } = harness();
  await sup.start();
  const grant = readGrant({ stateDir, agent: "spike" });
  assert.ok(grant, "a launched agent must have a capability record immediately");
  assert.equal(grant.kind, "withheld");
});

test("a non-owner's message leaves a withheld record keyed to the wake that carries it", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: F007 }));
  await sup.tick();

  assert.equal(sent.length, 1, "the agent is still woken — conversation stays free");
  const authority = authorityForLastWake(stateDir, sent);
  assert.ok(authority, "the wake's own turn must have an authority record");
  assert.equal(authority.kind, "withheld", "F-007's exact wording must produce a contained turn");
});

test("the owner's own message leaves a real grant on disk", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: OWNER, content: "@spike what is the BTC price?" }));
  await sup.tick();

  const authority = authorityForLastWake(stateDir, sent);
  assert.equal(authority.kind, "grant");
  assert.deepEqual(authority.capabilities, ["research"]);
});

test("an owner message the harness already delivered is keyed by that message itself", async () => {
  // No wake is published here — the relay handed it straight to the agent — so
  // the turn's trigger is the owner's own event and the record is keyed by it.
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  cli.deliver(msg({ id: "owner-direct-event", pubkey: OWNER, content: "@spike hello", tags: [["p", AGENT]] }));
  await sup.tick();

  assert.equal(sent.length, 0, "nothing to relay — the harness delivered it");
  const authority = readAuthority({ stateDir, agent: "spike", eventId: "owner-direct-event" });
  assert.equal(authority.kind, "grant");
  assert.deepEqual(authority.capabilities, ["research"]);
});

test("the node launches every agent with the tool gate wired in", async () => {
  const { sup, stateDir } = harness();
  await sup.start();
  const settingsFile = path.join(stateDir, "work", "spike", ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  const command = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "";
  assert.match(command, /toolgate\.mjs/, `expected the gate in ${command}`);
  assert.match(command, /--agent spike/);
  assert.ok(command.includes(stateDir), "the gate must be pointed at THIS node's state dir");
});

// ── The gate's refusals come back to the node ─────────────────────────────

function dropBlocked(stateDir, record) {
  const dir = path.join(stateDir, "blocked");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record), "utf8");
}

test("a refusal written by the gate becomes an approval request to the owner", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: F007 }));
  await sup.tick();
  sent.length = 0;

  // What the runtime gate writes when it refuses a call.
  dropBlocked(stateDir, {
    id: "b1", agent: "spike", capability: "research",
    detail: "WebFetch https://news.ycombinator.com/", at: Date.now(),
  });
  await sup.tick();

  // AC-67 (DD-57): the pair — the requester's notice and the owner's proposal.
  assert.equal(sent.length, 2, "the requester is told AND the owner is asked");
  const ask = sent.find((s) => /approve h4-/.test(s.content));
  assert.ok(ask, "the owner must be told");
  assert.deepEqual(ask.mentions, [OWNER]);
  const notice = sent.find((s) => s !== ask);
  assert.deepEqual(notice.mentions, [TAL], "and the requester learns where their ask went");
});

test("a consumed blocked record is not re-raised on the next tick", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: F007 }));
  await sup.tick();
  dropBlocked(stateDir, { id: "b2", agent: "spike", capability: "research", detail: "WebFetch x", at: Date.now() });
  await sup.tick();
  sent.length = 0;
  await sup.tick();
  await sup.tick();
  assert.equal(sent.length, 0, "the node polls every 2s — a record must be consumed exactly once");
});

test("the whole loop closes: contained, approved, granted, re-woken", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();

  cli.deliver(msg({ id: "e1", pubkey: TAL, content: F007 }));
  await sup.tick();
  assert.equal(authorityForLastWake(stateDir, sent).kind, "withheld");

  dropBlocked(stateDir, {
    id: "b3", agent: "spike", capability: "research",
    detail: "WebFetch https://news.ycombinator.com/", at: Date.now(),
  });
  await sup.tick();
  const ask = sent.find((s) => /approve h4-/.test(s.content));
  const token = ask.content.match(/approve (h4-[a-z0-9]+)/)[1];

  cli.deliver(msg({ id: "e2", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  // The released turn is triggered by the re-wake, so its grant is keyed there.
  const authority = authorityForLastWake(stateDir, sent);
  assert.equal(authority.kind, "grant");
  assert.deepEqual(authority.capabilities, ["research"]);
  assert.ok(
    sent.some((s) => s.content.includes("Hacker News")),
    "the original request must be re-run, not silently dropped",
  );
});

// ── One log, two writers (DD-16) ──────────────────────────────────────────

test("entries the gate appends from another process are visible to the chat query", () => {
  // F-007's fetch left no audit trail at all, because the only audit call sat
  // inside the classifier's branch. The gate now writes at the tool boundary —
  // a different PROCESS — so the log has to be read back, not just remembered.
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-audit-"));
  const file = path.join(dir, "audit.jsonl");
  const audit = new AuditLog({
    sink: { append: (line) => appendFileSync(file, `${line}\n`, "utf8") },
    source: { read: () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []) },
  });

  audit.action({ agent: "spike", actor: "node", kind: "launch", detail: "up" });
  appendFileSync(
    file,
    `${JSON.stringify({ type: "action", via: "toolgate", agent: "spike", actor: "runtime", kind: "research", decision: "deny", detail: "WebFetch news.ycombinator.com — deny", at: Date.now() })}\n`,
    "utf8",
  );

  const rows = audit.query({ agent: "spike" });
  assert.equal(rows.length, 2, `expected both writers' entries, got ${JSON.stringify(rows)}`);
  assert.ok(rows.some((r) => r.via === "toolgate"), "the gate's own entry must be queryable from chat");
});

test("a file-backed log still returns newest first", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-audit-"));
  const file = path.join(dir, "audit.jsonl");
  const audit = new AuditLog({
    sink: { append: (line) => appendFileSync(file, `${line}\n`, "utf8") },
    source: { read: () => readFileSync(file, "utf8").trim().split("\n").filter(Boolean) },
    now: (() => { let t = 1000; return () => (t += 10); })(),
  });
  audit.action({ agent: "spike", actor: "node", kind: "first", detail: "a" });
  audit.action({ agent: "spike", actor: "node", kind: "second", detail: "b" });
  assert.equal(audit.query({ agent: "spike" })[0].kind, "second");
});

test("a corrupt line in the log does not take the whole query down", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-audit-"));
  const file = path.join(dir, "audit.jsonl");
  writeFileSync(file, `{"type":"action","agent":"spike","kind":"ok","detail":"x","at":1}\nnot json at all\n`, "utf8");
  const audit = new AuditLog({
    source: { read: () => readFileSync(file, "utf8").trim().split("\n").filter(Boolean) },
  });
  assert.equal(audit.query({ agent: "spike" }).length, 1);
});

test("the node's audit log reads the file the gate writes to", async () => {
  const { sup, stateDir } = harness();
  await sup.start();
  appendFileSync(
    path.join(stateDir, "audit.jsonl"),
    `${JSON.stringify({ type: "action", via: "toolgate", agent: "spike", actor: "runtime", kind: "research", decision: "deny", detail: "WebFetch x — deny", at: Date.now() })}\n`,
    "utf8",
  );
  assert.ok(
    sup.audit.query({ agent: "spike" }).some((r) => r.via === "toolgate"),
    "`@spike /audit` must show what the gate contained",
  );
});

// ── Attribution survives concurrency (FIX-27, fix cycle 3) ────────────────

test("a blocked call is attributed to the turn that caused it, not the newest message", async () => {
  // F-009 end to end at the node. Barry (owner) asks directly; 40ms later tal
  // asks for something else. Barry's own fetch is refused by the gate. Before
  // FIX-27 the node read its single "last trigger" slot — tal's message — and
  // told Barry his own request was tal's. Now the runtime's turn record decides.
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();

  cli.deliver(msg({ id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price", tags: [["p", AGENT]] }));
  cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike check lobste.rs" }));
  await sup.tick();
  sent.length = 0;

  // The gate refused Barry's fetch, during the turn the runtime recorded for
  // Barry's own event.
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-owner", eventId: "e-owner", now: Date.now() });
  dropBlocked(stateDir, {
    id: "b-eth",
    agent: "spike",
    capability: "research",
    detail: "WebFetch https://api.coinbase.com/v2/prices/ETH-USD/spot",
    signature: "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot",
    promptId: "p-owner",
    at: Date.now(),
  });
  await sup.tick();

  const ask = sent.find((s) => /approve h4-/.test(s.content));
  assert.ok(ask, "the owner must be asked");
  assert.match(ask.content, /coinbase/, "and told which call was refused");
  // Post-DD-56 the owner edge is addressed to the owner directly ("for you")
  // rather than reciting their key; what F-009 requires is that tal's later
  // message cannot claim the attribution.
  assert.match(ask.content, /for you/, `the requester must be the owner, whose turn it was — got: ${ask.content}`);
  assert.deepEqual(ask.mentions, [OWNER]);
  assert.ok(!ask.content.includes(TAL.slice(0, 8)), "tal did not cause this turn");
});

test("approving that proposal re-wakes the agent onto the approved call", async () => {
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();

  cli.deliver(msg({ id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price", tags: [["p", AGENT]] }));
  await sup.tick();

  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-owner", eventId: "e-owner", now: Date.now() });
  dropBlocked(stateDir, {
    id: "b-eth2", agent: "spike", capability: "research",
    detail: "WebFetch https://api.coinbase.com/v2/prices/ETH-USD/spot",
    signature: "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot",
    promptId: "p-owner", at: Date.now(),
  });
  await sup.tick();
  const token = sent.find((s) => /approve h4-/.test(s.content)).content.match(/approve (h4-[a-z0-9]+)/)[1];
  sent.length = 0;

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  const wake = sent.find((s) => /coinbase/.test(s.content));
  assert.ok(wake, `the re-wake must name the approved call — sent: ${JSON.stringify(sent.map((s) => s.content))}`);

  // And the grant behind it is bound to that call, single-use.
  const authority = readAuthority({ stateDir, agent: "spike", eventId: wake.event_id });
  assert.equal(authority.kind, "grant");
  assert.equal(authority.signature, "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot");
  assert.equal(authority.proposalId, token);
});

test("AC-68 at the published wake: a granted cross-owner request is attributed to the OWNER", async () => {
  // "the action runs as the OWNER'S OWN request, exactly as if the owner had
  // asked for it" — so the attribution line the model (and the room) reads
  // names the owner, not the original asker. The original asker is on the
  // record in the proposal and the audit trail; the RUN is the owner's.
  const { sup, cli, sent, stateDir } = harness();
  await sup.start();

  cli.deliver(msg({ id: "e-tal-ask", pubkey: TAL, content: "@spike fetch the ETH price" }));
  await sup.tick();
  const talWake = sent.find((s) => /fetch the ETH price/.test(s.content));
  writeTurnRecord({ stateDir, agent: "spike", promptId: "p-tal", eventId: talWake.event_id, now: Date.now() });
  dropBlocked(stateDir, {
    id: "b-eth3", agent: "spike", capability: "research",
    detail: "WebFetch https://api.coinbase.com/v2/prices/ETH-USD/spot",
    signature: "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot",
    promptId: "p-tal", at: Date.now(),
  });
  await sup.tick();
  const token = sent.find((s) => /approve h4-/.test(s.content)).content.match(/approve (h4-[a-z0-9]+)/)[1];
  sent.length = 0;

  cli.deliver(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  await sup.tick();

  const wake = sent.find((s) => /coinbase/.test(s.content));
  assert.ok(wake, "the re-wake goes out");
  assert.match(wake.content, new RegExp(`Asked by .*${OWNER.slice(0, 8)}`), "the run is the owner's");
  assert.doesNotMatch(
    wake.content.split("\n")[0],
    new RegExp(TAL.slice(0, 8)),
    "the attribution line does not name the original asker",
  );
});
