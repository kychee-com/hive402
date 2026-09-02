// FIX-119 — one guided setup, in two shapes (AC-44).
//
// "Setup is a single guided step delivered in exactly two shapes, and no
//  installer: a script in the public repository that a person runs in a
//  terminal, or a line of text pasted to the coding agent they already use.
//  Both do the same work — identity, join, name, agent, first channel."
//
// The two shapes are two ways of REACHING this command, not two recipes. A
// second recipe drifts, and the one that drifts is always the one nobody ran
// this week — which is how the old skill.md came to describe a flow (`keys
// import --node`, `--sponsor keychain --owner-key keychain`) that FIX-115 and
// FIX-117 had already made wrong.
//
// Two properties matter more than the happy path here:
//
//   1. Every step is skippable. Setup is RESUMED more often than it is run:
//      something fails, a terminal is closed, a name is taken, the relay
//      hiccups. Re-running must pick up rather than refuse ("you already have
//      an identity") or repeat ("here is a second key").
//   2. The join is the one step this command cannot do for anybody. AC-45
//      requires the human to accept the policy themselves, and there is
//      deliberately no flag that does it on their behalf — so with no invite
//      and no prior join, setup STOPS and says who has to do what.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetup, starterConfig } from "../src/setup/run.mjs";
import { writeJoinRecord, readJoinRecord } from "../src/registry/joinrecord.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";
import { parseConfig } from "../src/config/schema.mjs";
import { resolveTools } from "../src/tools/resolve.mjs";

// ── The tool discovery, driven from a fixture rather than from THIS box ───
//
// F-039's own lesson, encoded. Every throwaway config in twenty cycles was
// built on a machine that happened to have Buzz installed where Buzz installs
// itself, so the one config shape a fresh machine produces — the one setup
// writes — was never actually launched. A setup test that reads the real
// filesystem is the same hole one level up: it would pass or fail depending on
// who ran it, and it would write this box's real paths into its own fixture.
//
// This is the REAL resolver with `platform`, `env`, `exists` and `npmRoot`
// injected, so what is exercised is the product's own discovery rather than a
// stand-in for it.
const BUZZ_DIR = "/opt/buzz";
const NPM_ROOT = "/opt/npm";
const ADAPTER = path.join(NPM_ROOT, "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const INSTALLED = new Set([path.join(BUZZ_DIR, "buzz"), path.join(BUZZ_DIR, "buzz-acp"), ADAPTER]);

const hermeticTools =
  ({ installed = INSTALLED } = {}) =>
  (config, opts) =>
    resolveTools(config, {
      ...opts,
      platform: "linux",
      env: {},
      npmRoot: NPM_ROOT,
      moduleUrl: "file:///checkout/src/tools/resolve.mjs",
      exists: (p) => installed.has(p),
    });


const NODE_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
// AC-72: a node key is stored under its own pubkey, so the fixtures need one.
const NODE_PUBKEY = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT_SK = "1111111111111111111111111111111111111111111111111111111111111111";
const HUMAN = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const A = "b86d8eda-5f05-496c-af45-ef4442ad5876";
const B = "11111111-2222-3333-4444-555555555555";

function store({ nodeKey = null, agentKeys = {} } = {}) {
  const made = [];
  return {
    made,
    // AC-72: keyed by the node's own pubkey. The fake keeps one hive, which is
    // all these fixtures need, but it must take the same arguments the real
    // store does or it would mistake a pubkey for a secret.
    async getNodePrivateKey(_pubkey) { return nodeKey; },
    async createNodePrivateKey(_pubkey, k) { made.push("node"); nodeKey = k; },
    async getAgentPrivateKey(name) { return agentKeys[name] ?? null; },
    async createAgentPrivateKey(name, k) { made.push(`agent:${name}`); agentKeys[name] = k; },
  };
}

function fixture({ joined = null } = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-setup-"));
  if (joined) writeJoinRecord({ stateDir, record: joined });
  const configFile = path.join(stateDir, "hive402.config.json");
  const written = [];
  const said = [];
  return {
    stateDir,
    configFile,
    written,
    said,
    log: (l) => said.push(String(l)),
    discoverTools: hermeticTools(),
    writeConfig: (args) => {
      written.push(args);
      writeFileSync(args.file, `${JSON.stringify(starterConfig(args), null, 2)}\n`, "utf8");
      return args.file;
    },
  };
}

const JOINED = {
  status: "joined", host: "relay.example", communityId: "kychee",
  origin: "https://relay.example", pubkey: derivePubkey(NODE_SK), role: "member",
};

const relay = (channels = [A]) => () => ({
  async myChannels() { return channels.map((channel) => ({ channel_id: channel })); },
  async visibleChannels() { return channels.map((channel) => ({ channel_id: channel })); },
  async channelMembers() { return []; },
  async getUser() { return null; },
  async setProfile() { return {}; },
});

const stateOf = (result, name) => result.steps.find((s) => s.name === name)?.state;
const detailOf = (result, name) => result.steps.find((s) => s.name === name)?.detail ?? "";

// ── The step that cannot be automated ─────────────────────────────────────

test("with no invite and no prior join, setup STOPS and says who must act", async () => {
  // AC-45 has no flag. This is the coding-agent shape's sequencing answer: the
  // human runs `hive402 join` in their own terminal, then setup continues.
  const f = fixture();
  const result = await runSetup({
    store: store(), stateDir: f.stateDir, configFile: f.configFile,
    writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => NODE_SK,
  });
  assert.equal(result.complete, false);
  assert.equal(stateOf(result, "join"), "blocked");
  assert.match(detailOf(result, "join"), /hive402 join <invite-link>/);
  assert.match(detailOf(result, "join"), /accept it yourself/i);
});

test("a node that has already joined skips the join entirely", async () => {
  const f = fixture({ joined: JOINED });
  const result = await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN, channel: A,
    makeCli: relay(), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  assert.equal(stateOf(result, "join"), "already");
  assert.equal(stateOf(result, "identity"), "already");
  assert.equal(result.complete, true);
});

// ── Resuming ──────────────────────────────────────────────────────────────

test("re-running does not mint a second identity or a second agent key", async () => {
  const f = fixture({ joined: { ...JOINED, displayName: "Barry's hive" } });
  const s = store({ nodeKey: NODE_SK, agentKeys: { spike: AGENT_SK } });
  const result = await runSetup({
    store: s, stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN, channel: A, nodeName: "Barry's hive",
    makeCli: relay(), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log,
    generate: () => { throw new Error("nothing may be generated on a resume"); },
  });
  assert.deepEqual(s.made, [], "nothing was created");
  assert.deepEqual(
    ["identity", "join", "name", "agent"].map((n) => stateOf(result, n)),
    ["already", "already", "already", "already"],
  );
  assert.equal(result.complete, true);
});

test("a missing agent name stops with the flag that fixes it", async () => {
  const f = fixture({ joined: JOINED });
  const result = await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    makeCli: relay(), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log,
  });
  assert.equal(stateOf(result, "agent"), "blocked");
  assert.match(detailOf(result, "agent"), /--agent <name>/);
});

test("a missing owner stops, and says it wants the PUBLIC key", async () => {
  // The one input that cannot be derived (DD-51): the node attests, but the
  // human approves, and nothing on this machine knows which Buzz account that
  // is. Saying "public" in the message is the whole point — this is the field
  // where someone with a key on their clipboard is most likely to paste it.
  const f = fixture({ joined: JOINED });
  const result = await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", makeCli: relay(), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log,
  });
  assert.equal(stateOf(result, "agent"), "blocked");
  assert.match(detailOf(result, "agent"), /PUBLIC key/);
  assert.match(detailOf(result, "agent"), /never wants the secret/i);
});

// ── The first channel ─────────────────────────────────────────────────────

test("one channel needs no question", async () => {
  const f = fixture({ joined: JOINED });
  const result = await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN,
    makeCli: relay([A]), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  assert.equal(stateOf(result, "channel"), "done");
  assert.match(detailOf(result, "channel"), new RegExp(A));
});

test("several channels is a question, and it lists them BY NAME", async () => {
  const f = fixture({ joined: JOINED });
  const result = await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN,
    makeCli: relay([A, B]), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  assert.equal(stateOf(result, "channel"), "blocked");
  // A person recognises a channel NAME. Nobody recognises a UUID, and a bare
  // run-together list of them is not a question anyone can answer — which is
  // exactly what a live run against 15 channels produced.
  const said = f.said.join(String.fromCharCode(10));
  assert.match(said, new RegExp("--channel " + A));
  assert.match(said, new RegExp("--channel " + B));
  assert.match(said, /Which channel should spike start in/i);
});

test("no channel visible at all says how to get one", async () => {
  const f = fixture({ joined: JOINED });
  const result = await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN,
    makeCli: relay([]), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  assert.equal(stateOf(result, "channel"), "blocked");
  assert.match(detailOf(result, "channel"), /no channels are visible/i);
});

// ── What it leaves behind ─────────────────────────────────────────────────

test("the config it writes is one the product can actually load", async () => {
  // The failure this prevents is the worst kind of onboarding bug: setup
  // reports success and the next command refuses the file it just wrote.
  const f = fixture({ joined: JOINED });
  await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN, channel: A,
    makeCli: relay(), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  const parsed = parseConfig(JSON.parse(readFileSync(f.configFile, "utf8")));
  assert.equal(parsed.relayUrl, "wss://relay.example", "http(s) became ws(s), which the schema requires");
  assert.equal(parsed.node.pubkey, derivePubkey(NODE_SK));
  assert.equal(parsed.rooms[0].channel, A);
  assert.equal(parsed.rooms[0].agents[0].name, "spike");
  assert.equal(parsed.rooms[0].agents[0].ownerPubkey, HUMAN, "the HUMAN approves, not the node");
  assert.equal(parsed.rooms[0].agents[0].research, false, "capabilities start off");
  assert.equal(parsed.rooms[0].agents[0].build, false);
});

test("the last thing it says is the next thing to run", async () => {
  const f = fixture({ joined: JOINED });
  await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN, channel: A,
    makeCli: relay(), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  const said = f.said.join("\n");
  assert.match(said, /hive402 register --agent spike/);
  assert.match(said, /nothing to paste/i, "and says the register step wants no key");
});

test("the node's name is published and remembered when one is given", async () => {
  const published = [];
  const f = fixture({ joined: JOINED });
  await runSetup({
    store: store({ nodeKey: NODE_SK }), stateDir: f.stateDir, configFile: f.configFile,
    nodeName: "Barry's hive", agentName: "spike", ownerPubkey: HUMAN, channel: A,
    makeCli: (opts) => ({
      ...relay()(opts),
      async setProfile(fields) { published.push(fields); return {}; },
    }),
    writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  assert.deepEqual(published, [{ name: "Barry's hive" }]);
  assert.equal(readJoinRecord(f.stateDir).displayName, "Barry's hive");
});

test("a clashing agent name stops setup before the key exists", async () => {
  const f = fixture({ joined: JOINED });
  const s = store({ nodeKey: NODE_SK });
  const result = await runSetup({
    store: s, stateDir: f.stateDir, configFile: f.configFile,
    agentName: "spike", ownerPubkey: HUMAN, channel: A,
    makeCli: () => ({
      async myChannels() { return [{ channel: A }]; },
      async channelMembers() { return []; },
      async getUser({ name }) { return name ? { pubkey: "cc".repeat(32), name: "spike" } : null; },
    }),
    writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => AGENT_SK,
  });
  assert.equal(stateOf(result, "agent"), "blocked");
  assert.match(detailOf(result, "agent"), /already resolves/i);
  assert.deepEqual(s.made, [], "no key was generated for a name that is taken");
});

test("a completed setup ends by naming the REGISTER step, not a superseded one", async () => {
  // FOUND BY RUNNING IT LIVE (2026-08-25): a setup that had done everything
  // ended with "Next: the join creates it". The identity step is recorded as
  // pending when an invite is supplied — the join mints the key — and nothing
  // marked it done afterwards, so the closing line picked it up and offered it
  // as the thing still to do.
  const f = fixture();
  const s = store();
  const result = await runSetup({
    invite: "https://relay.example/invite/v2.abc",
    agentName: "spike", ownerPubkey: HUMAN, channel: A, nodeName: "Barry's hive",
    store: s, stateDir: f.stateDir, configFile: f.configFile,
    makeCli: relay(), writeConfig: f.writeConfig, discoverTools: f.discoverTools, log: f.log, generate: () => NODE_SK,
    join: async () => {
      // The real join MINTS the node identity and stores it. A fake that skips
      // that is not modelling the flow being tested.
      await s.createNodePrivateKey(NODE_PUBKEY, NODE_SK);
      writeJoinRecord({ stateDir: f.stateDir, record: JOINED });
      return JOINED;
    },
  });
  assert.equal(result.complete, true);
  assert.equal(stateOf(result, "identity"), "done", "the join created it, so it is done");
  const said = f.said.join(String.fromCharCode(10));
  assert.match(said, /Next: hive402 register --agent spike/);
  assert.doesNotMatch(said, /Next: the join creates it/);
});


// ── F-039: the config setup writes is the one config nobody ever launched ──
//
// `setup` ran end to end, printed "Setup is complete. Run: hive402 up", and
// wrote a config with NO `tools` key at all — which `up` and `doctor` have
// always read. On a fresh machine the launcher therefore joined a null
// directory onto a hardcoded "buzz-acp.exe" (spawn ENOENT) and handed
// child_process a null adapter argument (ERR_INVALID_ARG_TYPE). Setup had
// already DISCOVERED buzz one line earlier, used it, and thrown the answer
// away.

const readWritten = (f) => JSON.parse(readFileSync(f.configFile, "utf8"));

const completeSetup = (f, over = {}) =>
  runSetup({
    store: store({ nodeKey: NODE_SK }),
    stateDir: f.stateDir,
    configFile: f.configFile,
    agentName: "spike",
    ownerPubkey: HUMAN,
    channel: A,
    makeCli: relay(),
    writeConfig: f.writeConfig,
    discoverTools: f.discoverTools,
    log: f.log,
    generate: () => AGENT_SK,
    ...over,
  });

test("setup writes down the tool paths it resolved, so up can read what will run", async () => {
  const fx = fixture({ joined: JOINED });
  const result = await completeSetup(fx);
  assert.equal(result.complete, true);

  const written = readWritten(fx);
  assert.deepEqual(
    written.tools,
    { buzzDir: path.dirname(path.join(BUZZ_DIR, "buzz-acp")), adapter: ADAPTER },
    "the block up reads has to be the block setup writes",
  );

  // Through the schema, because that is what `up` actually gets.
  const parsed = parseConfig(written);
  assert.equal(parsed.tools.buzzDir, path.dirname(path.join(BUZZ_DIR, "buzz-acp")));
  assert.equal(parsed.tools.adapter, ADAPTER);
  assert.notEqual(parsed.tools.buzzDir, null, "a null here is the whole of F-039");
  assert.notEqual(parsed.tools.adapter, null, "and this null is what reached child_process");
});

test("the closing report says what it resolved rather than leaving up to discover it", async () => {
  const fx = fixture({ joined: JOINED });
  const result = await completeSetup(fx);
  assert.equal(stateOf(result, "tools"), "done");
  assert.match(detailOf(result, "tools"), /buzz-acp/);
  assert.match(detailOf(result, "tools"), /claude-agent-acp/);
});

test("with nothing installed the block admits it rather than inventing a path", async () => {
  // The nuance that matters: `path.dirname("buzz")` is ".", and a relative "."
  // written into a config is exactly the bare-relative-path defect this fix
  // removes. An honest null costs nothing — the schema treats it and an absent
  // key alike — and it is the thing an operator can see and fill in.
  const fx = fixture({ joined: JOINED });
  fx.discoverTools = hermeticTools({ installed: new Set() });
  const result = await completeSetup(fx, { discoverTools: fx.discoverTools });

  assert.deepEqual(readWritten(fx).tools, { buzzDir: null, adapter: null });

  // And setup SAYS so, at the point a person is still reading, with the remedy.
  assert.equal(stateOf(result, "tools"), "skipped");
  assert.ok(
    detailOf(result, "tools").includes("npm install -g @agentclientprotocol/claude-agent-acp"),
    detailOf(result, "tools"),
  );
  assert.match(detailOf(result, "tools"), /buzz-acp not found/);
  // Not blocked: the config and the register instruction are still worth
  // having, and both `doctor` and `up` name the same remedy again.
  assert.equal(result.complete, true);
});

test("a hand-written block is written back as given, never replaced by discovery", async () => {
  // Doctrine 1 through the whole command, and the property that keeps Barry's
  // live config safe: a resumed setup must not blank or "correct" a path its
  // owner chose, even when the binary is not there today.
  const fx = fixture({ joined: JOINED });
  const result = await completeSetup(fx, {
    config: { relayUrl: "wss://relay.example", tools: { buzzDir: "/operator/said/here", adapter: null } },
  });

  const written = readWritten(fx);
  assert.equal(written.tools.buzzDir, "/operator/said/here", "the operator's answer is not second-guessed");
  assert.notEqual(
    written.tools.buzzDir,
    path.dirname(path.join(BUZZ_DIR, "buzz-acp")),
    "and a discovered Buzz must not displace it",
  );
  assert.equal(written.tools.adapter, ADAPTER, "what was NOT configured is still discovered");
  // The miss is reported against the operator's own path.
  assert.equal(stateOf(result, "tools"), "skipped");
  assert.equal(result.complete, true);
});
