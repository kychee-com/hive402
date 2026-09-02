// An agent's character is configuration, not memory (AC-55, AC-18, DD-45,
// FIX-112).
//
// What an agent IS gets set by its owner in the open, in a file the owner can
// read and change at any time. What it LEARNS lives in the conversation. The
// distinction is the whole of F-9: nothing about an agent is private to it, and
// no self-authored identity exists that its owner cannot read.
//
// ── Layered, never substituted ─────────────────────────────────────────────
//
// The instructions go to the harness as `BUZZ_ACP_TEAM_INSTRUCTIONS`
// (`crates/buzz-acp/src/config.rs`, buzz @ a2d8be5ef), which
// `queue.rs::StandingContext::sections` renders as its own `[Team Instructions]`
// block AFTER `[Base]` and `[System]` and BEFORE agent memory. The base prompt
// is untouched, which is the point: it carries upstream's own guards, including
// its prompt-injection guard, and replacing it (`--system-prompt`, or opting
// out of the base entirely) would silently shed every one of them on the next
// upstream bump. This resolves FIX-99 in favour of layering.
//
// ── The agent may never edit its own ───────────────────────────────────────
//
// AC-55 states that absolutely, so it is pinned through the REAL gate rather
// than asserted about the config layer. Under DD-35 it held because `build`
// never rode a blanket grant; since spec 0.7.0 the owner's own turn CARRIES
// build (DD-56), so the property rests on the governed-files tier instead:
// `.hive402/**`, `.claude/**` and the agent's own instructions file are
// refused before any record is consulted, whatever the grant says.
//
// The hole that check does NOT close on its own is an `instructionsFile` the
// owner points INTO the agent's own scratch directory — writes there classify
// as composition, so the agent could rewrite its own character and a respawn
// would adopt it. The launcher refuses that configuration outright.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { parseConfig, DEFAULT_AGENT_SETTINGS } from "../src/config/schema.mjs";
import {
  HOUSE_ETIQUETTE,
  composeInstructions,
  instructionsFilePath,
  resolveInstructions,
} from "../src/launcher/instructions.mjs";
import { buildAgentEnv } from "../src/launcher/env.mjs";
import { decideTool } from "../src/runtime/toolgate.mjs";
import { ownerTurnCapabilities } from "../src/runtime/grants.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

const rawConfig = (agentOver = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE },
  rooms: [
    {
      channel: "b86d8eda-5f05-496c-af45-ef4442ad5876",
      agents: [{ name: "spike", pubkey: SPIKE, ownerPubkey: OWNER, ...agentOver }],
    },
  ],
});

const agentIn = (cfg) => cfg.rooms[0].agents[0];

// A node whose spawn is captured, so the tests below can read the env of the
// process that was really started.
function launchHarness({ dir, agentOver = {} }) {
  const spawned = [];
  const cfg = parseConfig(rawConfig({ privateKeyRef: "env:TEST_AGENT_KEY", ...agentOver }));
  cfg.tools = { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] };
  const cli = {
    getMessages: async () => [],
    send: async () => ({ accepted: true, event_id: "e" }),
    setProfile: async () => ({ accepted: true }),
    getUser: async ({ pubkey, name }) =>
      name ? { pubkey: SPIKE, display_name: name } : { pubkey, display_name: "spike" },
  };
  const sup = new Supervisor({
    config: cfg,
    configDir: dir,
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-state-")),
    spawn: (bin, args, opts) => {
      spawned.push({ bin, args, opts });
      return { pid: 4242, exitCode: null, killed: false, kill() {} };
    },
    makeCli: () => cli,
    readAttestation: (a) => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: a.pubkey }),
    resolveKey: () => "bb".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { spawned, sup };
}

// ── The config field ────────────────────────────────────────────────────────

test("an agent may carry an instructions string", () => {
  const cfg = parseConfig(rawConfig({ instructions: "You are terse and you like trains." }));
  assert.equal(agentIn(cfg).instructions, "You are terse and you like trains.");
});

test("an agent may point at an instructions file instead", () => {
  const cfg = parseConfig(rawConfig({ instructionsFile: "./spike.md" }));
  assert.equal(agentIn(cfg).instructionsFile, "./spike.md");
  assert.equal(agentIn(cfg).instructions, null);
});

test("naming both is refused rather than silently preferring one", () => {
  assert.throws(
    () => parseConfig(rawConfig({ instructions: "a", instructionsFile: "./b.md" })),
    /both/i,
  );
});

test("a non-string is refused", () => {
  for (const bad of [42, true, {}, []]) {
    assert.throws(() => parseConfig(rawConfig({ instructions: bad })), /instructions/);
    assert.throws(() => parseConfig(rawConfig({ instructionsFile: bad })), /instructionsFile/);
  }
});

test("an empty instructions field is a mistake, not a way to say nothing", () => {
  assert.throws(() => parseConfig(rawConfig({ instructions: "   " })), /empty/i);
  assert.throws(() => parseConfig(rawConfig({ instructionsFile: "" })), /empty/i);
});

test("an agent with no instructions has none, and that is fine", () => {
  const cfg = parseConfig(rawConfig());
  assert.equal(agentIn(cfg).instructions, null);
  assert.equal(agentIn(cfg).instructionsFile, null);
});

test("instructions are NOT one of the six settings (AC-18)", () => {
  // AC-18 is explicit: the six are a closed set of switches with defined
  // values; instructions are free text describing who the agent is. Letting
  // them into DEFAULT_AGENT_SETTINGS would make them a seventh switch and
  // would put them in the "unknown setting" error message as one.
  assert.equal("instructions" in DEFAULT_AGENT_SETTINGS, false);
  assert.deepEqual(Object.keys(DEFAULT_AGENT_SETTINGS).sort(), [
    "build",
    "crossOwnerAsks",
    "replyMode",
    "research",
    "selfInitiated",
  ]);
});

test("an unknown setting is still refused", () => {
  assert.throws(() => parseConfig(rawConfig({ personality: "grumpy" })), /unknown setting/);
});

// ── Resolving the owner's text ──────────────────────────────────────────────

test("a string resolves to itself", () => {
  assert.equal(resolveInstructions({ agent: { instructions: "be terse" }, configDir: "." }), "be terse");
});

test("a file resolves relative to the config file's own directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-instr-"));
  writeFileSync(path.join(dir, "spike.md"), "You are spike.\nYou like trains.\n", "utf8");
  assert.match(
    resolveInstructions({ agent: { instructionsFile: "./spike.md" }, configDir: dir }),
    /You like trains/,
  );
});

test("a missing instructions file fails loudly, naming the path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-instr-"));
  assert.throws(
    () => resolveInstructions({ agent: { name: "spike", instructionsFile: "./nope.md" }, configDir: dir }),
    /nope\.md/,
  );
});

test("no instructions resolves to null, not to an empty string", () => {
  assert.equal(resolveInstructions({ agent: {}, configDir: "." }), null);
});

// ── The layered text ────────────────────────────────────────────────────────

test("the house etiquette is present even when the owner wrote nothing", () => {
  const layered = composeInstructions({ ownerText: null });
  assert.ok(layered.length > 0);
  assert.equal(layered.includes(HOUSE_ETIQUETTE), true);
});

test("the owner's own words are carried verbatim", () => {
  const layered = composeInstructions({ ownerText: "You are spike. You like trains." });
  assert.match(layered, /You like trains\./);
  assert.equal(layered.includes(HOUSE_ETIQUETTE), true, "and the house rules travel with them");
});

// ── The harness contract: layered, never substituted ───────────────────────

const room = {
  relayUrl: "ws://localhost:3000",
  respondTo: "anyone",
  channel: "b86d8eda-5f05-496c-af45-ef4442ad5876",
};
const agent = {
  name: "spike",
  ownerPubkey: OWNER,
  authTag: ["auth", OWNER, "", "b".repeat(128)],
};
const secrets = { agentPrivateKey: "b".repeat(64) };

test("the instructions reach the harness as TEAM instructions", () => {
  const env = buildAgentEnv({ agent, room, secrets, instructions: "You like trains." });
  assert.match(env.BUZZ_ACP_TEAM_INSTRUCTIONS, /You like trains\./);
});

test("the base prompt is never replaced — that is the whole of DD-45", () => {
  const env = buildAgentEnv({ agent, room, secrets, instructions: "You like trains." });
  for (const substitution of [
    "BUZZ_ACP_SYSTEM_PROMPT",
    "BUZZ_ACP_BASE_PROMPT",
    "BUZZ_ACP_NO_BASE_PROMPT",
  ]) {
    assert.equal(
      env[substitution],
      undefined,
      `${substitution} would shed upstream's own guards, including its prompt-injection guard`,
    );
  }
});

test("an agent with no owner instructions still gets the house etiquette", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.ok(env.BUZZ_ACP_TEAM_INSTRUCTIONS, "AC-49/50/53/54 apply to every agent, configured or not");
});

test("the layered text is never blank — the harness drops an empty value", () => {
  // config.rs trims and filters empty team instructions, so a blank value is
  // the same as not setting one at all. Nothing should reach that filter.
  const env = buildAgentEnv({ agent, room, secrets, instructions: "   " });
  assert.ok(env.BUZZ_ACP_TEAM_INSTRUCTIONS.trim().length > 0);
});

// ── The agent may never edit its own instructions ───────────────────────────

const CONFIG_PATH = "C:/Users/barry/.hive402/config.json";
const WORKDIR = "C:/hive402/work/spike";
const now = 1_700_000_000_000;

test("REAL GATE: writing the config on a withheld turn is refused", () => {
  const verdict = decideTool({
    toolName: "Write",
    toolInput: { file_path: CONFIG_PATH },
    grant: null,
    promptId: "p1",
    cwd: WORKDIR,
    now,
  });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.capability, "build");
});

test("REAL GATE: even the owner's build-carrying turn cannot write the config (DD-56's governance tier)", () => {
  // The sharper post-0.7.0 form of the old assertion. An owner's ordinary turn
  // now holds `build` (AC-16: "If I ask it auto does") — and the config write
  // is still refused, because `.hive402/**` is never the agent's to edit on
  // any turn. No grant reaches that branch, so no grant can widen it.
  const enabled = ownerTurnCapabilities({ research: true, build: true });
  assert.equal(enabled.includes("build"), true, "the premise: build genuinely rides the owner's turn now");

  const grant = {
    kind: "grant",
    capabilities: enabled,
    issuedAt: now,
    expiresAt: now + 60_000,
    boundPromptId: null,
  };
  const verdict = decideTool({
    toolName: "Write",
    toolInput: { file_path: CONFIG_PATH },
    grant,
    promptId: "p1",
    cwd: WORKDIR,
    now,
  });
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, /never the agent's/i, "denied by governance, not by a missing capability");
});

test("REAL GATE: a shell redirect at the config is a build, not composition", () => {
  const verdict = decideTool({
    toolName: "Bash",
    toolInput: { command: `echo '{"rooms":[]}' > ${CONFIG_PATH}` },
    grant: null,
    promptId: "p1",
    cwd: WORKDIR,
    now,
  });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.capability, "build");
});

test("an instructionsFile inside the agent's own scratch directory is refused at launch", () => {
  // The one place the gate cannot help: writes inside the agent's working
  // directory classify as composition, so a character file living there is a
  // character the agent can rewrite — and the next respawn would adopt it.
  // AC-55 says never, so this configuration does not start.
  const inside = path.join(WORKDIR, "character.md");
  assert.throws(
    () =>
      buildAgentEnv({
        agent: { ...agent, instructionsFile: inside },
        room,
        secrets,
        instructions: "You like trains.",
        instructionsPath: instructionsFilePath({ agent: { instructionsFile: inside }, configDir: "C:/anywhere" }),
        workDir: WORKDIR,
      }),
    /own working directory/i,
  );
});

test("an instructionsFile outside the working directory is fine", () => {
  const outside = "C:/Users/barry/.hive402/spike.md";
  assert.doesNotThrow(() =>
    buildAgentEnv({
      agent: { ...agent, instructionsFile: outside },
      room,
      secrets,
      instructions: "You like trains.",
      instructionsPath: instructionsFilePath({ agent: { instructionsFile: outside }, configDir: "C:/anywhere" }),
      workDir: WORKDIR,
    }),
  );
});

test("the path is resolved ONCE, against the config, and reused by the guard", () => {
  // The bug a real launch caught: `"./spike.md"` next to the config is not a
  // file in the agent's scratch directory, but a guard that re-resolves the
  // relative path against the WORKING directory concludes that it is, and the
  // node refuses to start over a perfectly ordinary configuration.
  const relative = { instructionsFile: "./spike.md" };
  assert.equal(
    instructionsFilePath({ agent: relative, configDir: "C:/Users/barry/.hive402" }),
    path.resolve("C:/Users/barry/.hive402", "./spike.md"),
  );
  assert.doesNotThrow(() =>
    buildAgentEnv({
      agent: { ...agent, ...relative },
      room,
      secrets,
      instructionsPath: instructionsFilePath({ agent: relative, configDir: "C:/Users/barry/.hive402" }),
      workDir: WORKDIR,
    }),
  );
});

// ── The node actually launches an agent with them ───────────────────────────
//
// `buildAgentEnv` accepting an `instructions` argument proves nothing on its
// own: this project has shipped six modules whose only caller was a test, and
// a `replyTo` parameter that no production code ever passed. These drive
// `Supervisor.start()` and read the env of the process that was really spawned.

test("CALLER: the spawned agent process carries its owner's instructions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-launch-"));
  const { spawned, sup } = launchHarness({ dir, agentOver: { instructions: "You are spike. You like trains." } });
  await sup.start();

  assert.equal(spawned.length, 1);
  const env = spawned[0].opts.env;
  assert.match(env.BUZZ_ACP_TEAM_INSTRUCTIONS, /You like trains\./, "the owner's text reached the harness");
  assert.match(env.BUZZ_ACP_TEAM_INSTRUCTIONS, /hive402 room rules/, "and so did the house rules");
});

test("CALLER: an instructionsFile is read relative to the CONFIG, not the cwd", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-launch-"));
  writeFileSync(path.join(dir, "spike.md"), "You are spike, and you are fond of canals.\n", "utf8");
  const { spawned, sup } = launchHarness({ dir, agentOver: { instructionsFile: "./spike.md" } });
  await sup.start();
  assert.match(spawned[0].opts.env.BUZZ_ACP_TEAM_INSTRUCTIONS, /fond of canals/);
});

test("CALLER: an agent with no instructions still launches with the house rules", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-launch-"));
  const { spawned, sup } = launchHarness({ dir });
  await sup.start();
  assert.match(spawned[0].opts.env.BUZZ_ACP_TEAM_INSTRUCTIONS, /hive402 room rules/);
});

test("CALLER: a missing instructionsFile fails the launch rather than starting a stranger", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-launch-"));
  const { sup } = launchHarness({ dir, agentOver: { instructionsFile: "./gone.md" } });
  await assert.rejects(() => sup.start(), /gone\.md/);
});
