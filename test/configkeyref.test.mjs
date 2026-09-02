// FIX-136 (hive402#4, AC-33/AC-36) — `join` and `register` use the identity the
// CONFIG declares, not the credential store's default entry.
//
// ── What it cost to find this ──────────────────────────────────────────────
//
// `up` honours `node.privateKeyRef` — every key the running node touches goes
// through `makeKeyResolver`, so a config saying `"env:RIG_NODE_KEY"` runs as
// the rig's throwaway identity. `join` and `register` did not: both resolved
// the node identity from the OS credential store's default entry, whichever
// config they were pointed at.
//
// On a machine that also runs a production node that entry IS the production
// identity. Standing up a two-node cover rig on 2026-08-30 therefore joined
// the throwaway community AS THE REAL NODE, consumed a single-use invite, and
// published an `alpha` registration hosted by a node that will never serve it.
//
// ── Why this is a prerequisite and not a nice-to-have ──────────────────────
//
// The cover belt (TOOL-003) is handed to the Red Team, who hold no keys and
// should not have to know this trap exists. A belt script that can silently
// act as the production node is not a test tool, it is an incident waiting for
// a spare evening. The config is the ONLY thing standing between the two, so
// the config has to be obeyed.
//
// The rule these tests pin: a config that names an env reference must never
// read the credential store for the node identity. Not "prefers the ref" —
// never reads the store, because reading it is what picked the wrong key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runJoin } from "../src/registry/joincommand.mjs";
import { registerAgent } from "../src/node/runtime.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";

// The rig's throwaway identity, and the one that must never be reached for.
const RIG_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const PROD_SK = "1c99b6af66cb7459ce23af6d1c447c73b68257e2d789a8fd61a5148575327e54";
const RIG_PK = derivePubkey(RIG_SK);
const PROD_PK = derivePubkey(PROD_SK);

const CODE = "v2.YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE";
const LINK = `https://relay.example/invite/${CODE}`;
const now = 1_700_000_000_000;

// A credential store holding the PRODUCTION identity, which is what this box
// really looks like. Every read is recorded: the assertion is about what was
// touched, not only about what came out.
function productionStore({ named = false } = {}) {
  const calls = [];
  const minted = [];
  return {
    calls,
    minted,
    named,
    async getNodePrivateKey() {
      calls.push("getNodePrivateKey");
      return PROD_SK;
    },
    // AC-72: minting is correct for a hive nothing names, and a defect when
    // one was named — that is the whole guard, and it is now stated that way
    // rather than by refusing every mint.
    async createNodePrivateKey(pubkey, secret) {
      calls.push("createNodePrivateKey");
      if (this.named) throw new Error("a config-declared identity must never mint a new key");
      minted.push({ pubkey, secret });
    },
    async getAgentPrivateKey(name) {
      calls.push(`getAgentPrivateKey:${name}`);
      return PROD_SK;
    },
  };
}

const relay = () => {
  const calls = [];
  return {
    calls,
    impl: async (url, options = {}) => {
      calls.push({ url, ...options });
      const reply = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => "" });
      if (url.endsWith("/api/join-policy")) return reply({});
      return reply({ status: "joined", community_id: "rig", host: "relay.example", role: "member" });
    },
  };
};

const accepts = async () => ({ accepted: true, ageConfirmed: true });

// ── join ──────────────────────────────────────────────────────────────────

test("THE BUG: join with a config declaring an env ref never reads the credential store", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-keyref-"));
  const store = productionStore();
  process.env.TEST_RIG_NODE_KEY = RIG_SK;

  const result = await runJoin({
    link: LINK,
    store,
    stateDir,
    privateKeyRef: "env:TEST_RIG_NODE_KEY",
    consent: accepts,
    fetchImpl: relay().impl,
    now,
    log: () => {},
  });

  assert.equal(result.pubkey, RIG_PK, "joined as the identity the config names");
  assert.notEqual(result.pubkey, PROD_PK, "and emphatically not as the production node");
  assert.deepEqual(store.calls, [], "the credential store was never even asked");
});

test("join with nothing naming a hive MINTS one, rather than adopting a machine's key", async () => {
  // CHANGED BY AC-72. There is no machine-wide node identity to fall back on
  // any more: a key is stored under its own pubkey, so with no config naming a
  // hive and no join record in this state directory, this is a NEW hive and one
  // is minted for it. Adopting "the" key is exactly what would let a second
  // hive inherit the first one's identity.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-keyref-"));
  const store = productionStore();

  const result = await runJoin({
    link: LINK,
    store,
    stateDir,
    consent: accepts,
    fetchImpl: relay().impl,
    now,
    log: () => {},
  });

  assert.notEqual(result.pubkey, PROD_PK, "the production identity must not be adopted");
  assert.deepEqual(store.calls, ["createNodePrivateKey"], "minted, never read from a shared slot");
});

test("join for a config-NAMED hive uses that hive's key, because that is what it says", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-keyref-"));
  const store = productionStore();

  const result = await runJoin({
    link: LINK,
    store,
    stateDir,
    privateKeyRef: "keychain",
    // AC-72: WHICH hive. FIX-136's property survives the change — a declared
    // identity is honoured — it just has to be declared rather than assumed.
    nodePubkey: PROD_PK,
    consent: accepts,
    fetchImpl: relay().impl,
    now,
    log: () => {},
  });

  assert.equal(result.pubkey, PROD_PK);
});

test("a declared ref that is not set fails loudly rather than falling back to the store", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-keyref-"));
  const store = productionStore();
  delete process.env.TEST_MISSING_NODE_KEY;

  await assert.rejects(
    runJoin({
      link: LINK,
      store,
      stateDir,
      privateKeyRef: "env:TEST_MISSING_NODE_KEY",
      consent: accepts,
      fetchImpl: relay().impl,
      now,
      log: () => {},
    }),
    /TEST_MISSING_NODE_KEY is not set/,
  );
  assert.deepEqual(store.calls, [], "a silent fallback here is the whole bug");
});

// ── register ──────────────────────────────────────────────────────────────

const rigConfig = ({ ref = "env:TEST_RIG_NODE_KEY" } = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: RIG_PK, privateKeyRef: ref },
  tools: { buzzDir: "C:\\Buzz", nodeDir: null, adapter: null, extraDirs: [] },
  rooms: [
    {
      channel: "b86d8eda-5f05-496c-af45-ef4442ad5876",
      agents: [
        {
          name: "alpha",
          pubkey: "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c",
          ownerPubkey: "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a",
          privateKeyRef: "env:TEST_RIG_AGENT_KEY",
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

// Which reference each role was resolved from — the question the bug is about.
function recordingResolver() {
  const asked = [];
  return {
    asked,
    resolve: async (ref, { role, agent } = {}) => {
      asked.push({ ref: ref ?? null, role: role ?? null, agent: agent ?? null });
      if (ref === "env:TEST_RIG_NODE_KEY") return RIG_SK;
      if (ref === "env:TEST_RIG_AGENT_KEY") return RIG_SK;
      // "keychain" — the credential store's default, i.e. production here.
      return PROD_SK;
    },
  };
}

test("THE BUG: register with no --sponsor uses the config's own node ref", async () => {
  const resolver = recordingResolver();
  await registerAgent({
    config: rigConfig(),
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-keyref-")),
    agentName: "alpha",
    resolveKey: resolver.resolve,
    makeCli: () => ({
      async channelMembers() {
        return [{ pubkey: RIG_PK }];
      },
      async send() {
        return { accepted: true, event_id: "x" };
      },
      async setProfile() {
        return { accepted: true };
      },
      async getUser() {
        return null;
      },
      async submitEvent() {
        return { published: true };
      },
    }),
  }).catch(() => {}); // the publish half may not complete in this stub; the refs are the point

  const refs = resolver.asked.filter((a) => a.role === "sponsor" || a.role === "attester");
  assert.ok(refs.length > 0, "precondition: the node identity is resolved at all");
  for (const asked of refs) {
    assert.equal(
      asked.ref,
      "env:TEST_RIG_NODE_KEY",
      `the ${asked.role} identity must come from the config, not "keychain"`,
    );
  }
});

test("an explicit --sponsor still wins, so the documented workaround keeps working", async () => {
  const resolver = recordingResolver();
  await registerAgent({
    config: rigConfig(),
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-keyref-")),
    agentName: "alpha",
    sponsorRef: "keychain",
    ownerKeyRef: "keychain",
    resolveKey: resolver.resolve,
    makeCli: () => ({
      async channelMembers() {
        return [{ pubkey: PROD_PK }];
      },
      async send() {
        return { accepted: true, event_id: "x" };
      },
      async setProfile() {
        return { accepted: true };
      },
      async getUser() {
        return null;
      },
      async submitEvent() {
        return { published: true };
      },
    }),
  }).catch(() => {});

  const sponsor = resolver.asked.find((a) => a.role === "sponsor");
  assert.equal(sponsor?.ref, "keychain", "an explicit flag is still an instruction");
});

// ── The wiring, guarded structurally ──────────────────────────────────────
//
// The library is fixed above; the COMMAND is what a person actually runs, and
// this product has been bitten before by a correct mechanism that no real
// entry point reached (FIX-74's respawn, `LoopGuard.allow`). The commands
// drive a terminal and a credential store, so they are guarded the way
// `respawn.test.mjs` guards its call site: assert the wiring exists.

test("the join command hands the config's ref to runJoin", () => {
  const source = readFileSync(new URL("../bin/cli.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function cmdJoin"), source.indexOf("async function cmdSetup"));
  assert.match(
    body,
    /privateKeyRef:\s*config\?\.node\?\.privateKeyRef/,
    "cmdJoin must pass the declared reference, or the fix above is unreachable",
  );
  // Through the AC-73 seam since 0.9.0: resolving a config and saying WHICH
  // hive it named are one act, so no command calls loadConfig directly.
  // The shape changed with F-038: `join` resolves PARTIALLY, because a config
  // that is not yet launch-ready still names a state directory. It is the same
  // seam and the same banner, so this asserts the two properties directly
  // rather than one spelling of them.
  assert.match(body, /=\s*resolveHive\(/, "and must actually resolve through the announcing seam");
  assert.match(body, /\bconfig\b/, "binding the config it read, so the ref above is reachable");
  assert.doesNotMatch(body, /loadConfig\(/, "never around the seam");
});

test("the register command lets the config decide when no flag was given", () => {
  const source = readFileSync(new URL("../bin/cli.mjs", import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("async function cmdRegister"),
    source.indexOf("async function cmdJoin"),
  );
  assert.match(body, /sponsorRef:\s*flags\.sponsor\s*\?\?\s*null/, 'not ?? "keychain" — that WAS the bug');
  assert.doesNotMatch(body, /\?\?\s*"keychain"/, "no path here may default to the store behind the config");
});
