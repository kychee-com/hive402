// A name declared in THIS config is a collision, not the caller (AC-56, F-037,
// FIX-178..FIX-182, DD-70).
//
// ── The defect, in one line ────────────────────────────────────────────────
//
// `makeNameCheck`'s `placeInConfig` looked the name up in the resolving config
// and handed `checkAgentName` three things: `channel`, `ownerPubkey` — and
// `selfPubkey: agent.pubkey`. The first two NARROW the question. The third is
// an EXCLUSION, and `checkAgentName` honours it in both questions that can
// refuse:
//
//     if (!pubkey || pubkey === self || seen.has(pubkey)) continue;   // room
//     if (holder && holder !== self && …) refusals.push(…)            // relay
//
// It means "this is the identity performing the check, so finding it is not a
// clash." True at `register`, where the config entry IS the agent registering
// itself. False at `keygen`, which mints a key that does not exist yet: there
// is no self, so the config-declared holder is a DIFFERENT identity that
// already owns the name — the strongest collision signal there is, fed in as
// an exemption.
//
// The defect class, named so it stops recurring: **a value meaning "ignore
// this" derived from a lookup that means "here is the answer."**
//
// ── Why this file drives keygen and not `checkAgentName` ──────────────────
//
// The bug is in the WIRING, not in the lookup. `checkAgentName` behaves
// correctly for every input it is given; it was given the wrong one. A test
// that calls `checkAgentName` directly with hand-written arguments would pass
// on the broken build, because the broken build's mistake is which arguments
// it passes. So every cell below drives the real `keygen` + the real
// `makeNameCheck`, composed exactly as `bin/cli.mjs` composes them, with only
// the relay CLI stubbed.
//
// ── The four cells, one variable ──────────────────────────────────────────
//
//   A  declared in config WITH the holder's pubkey   -> refuses, no key,
//                                                       named as the owner's own
//   B  not in config, held on the relay              -> refuses, cross-owner
//                                                       wording, byte for byte
//   C  declared in config with a DIFFERENT pubkey    -> refuses (room), unchanged
//   D  declared WITH the holder's pubkey, name free  -> PROCEEDS
//
// C is the discriminator: it proves the config entry is not poisonous in
// itself — only the entry whose pubkey IS the holder was. D is the
// over-correction guard: a fix that refuses because the name is in the config
// fails it, and D is the cell every ordinary `--force` rotation runs through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { keygen, removePrivateKey, derivePubkey } from "../src/credentials/keys.mjs";
import { makeNameCheck } from "../src/registry/namecheckcommand.mjs";
import { runSetup, starterConfig } from "../src/setup/run.mjs";
import { writeJoinRecord } from "../src/registry/joinrecord.mjs";

const lower = (v) => String(v ?? "").toLowerCase();

// A real node secret: `makeNameCheck` resolves one before it will ask anything.
const NODE_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
// The pubkey that really holds "spike" — the owner's own agent.
const HOLDER = "43e1b966".padEnd(64, "a");
// Someone else's agent, holding the name. Rung 4: no ownership claim.
const STRANGER = "c0ffee00".padEnd(64, "c");
// A pubkey declared for "spike" in the config that is NOT the holder — a stale
// entry, or an identity whose key was rotated. Cell C.
const STALE = "9d5b1104".padEnd(64, "d");
// A Buzz Desktop agent of the owner's, reachable only through the roster.
const DESKTOP = "77b41c39".padEnd(64, "e");

const CHANNEL = "6f30305c-7903-42e4-912e-502ceedf15b8";
const AGENT_SK = "1111111111111111111111111111111111111111111111111111111111111111";

// ── The config, with one variable: what "spike" is declared as ────────────
//
// `relayUrl` and `node.pubkey` are what make the checker able to ask anything
// at all; `privateKeyRef` is declared so the fixtures can hand it a key
// without an OS keychain (FIX-170's seam, same as `runProfile`'s).
function config(spikeEntry = null) {
  const agents = [
    {
      name: "probe1",
      pubkey: DESKTOP,
      ownerPubkey: OWNER,
      privateKeyRef: "env:PROBE1",
      research: false,
      build: false,
      crossOwnerAsks: "owner-approves",
      selfInitiated: "asks-owner",
      replyMode: "addressed-only",
    },
  ];
  if (spikeEntry) agents.push({ ...agents[0], name: "spike", ...spikeEntry });
  return {
    relayUrl: "ws://localhost:3000",
    node: { pubkey: OWNER, privateKeyRef: "env:NODE" },
    turnCap: { limit: 20, windowMs: 3600000 },
    tools: { buzzDir: "C:/Buzz", nodeDir: "C:/node", adapter: "C:/adapter.js", extraDirs: [] },
    rooms: [{ channel: CHANNEL, agents }],
  };
}

// ── The relay, as it actually answers ─────────────────────────────────────
//
// `owner`-scoped `getUser` returns null ALWAYS. That is not a simplification:
// `buzz users get --name <n> --owner <hex>` queries the kind-30177 Desktop
// roster, hive402 publishes no such record, and the right owner and the wrong
// owner get the same empty array (TR-022). A mock that answers it is the mock
// that hid F-036 for a cycle. `roster` opts one specific fixture back in, for
// the one case that is genuinely about the Desktop rung.
function relay({ members = [], holds = null, roster = null } = {}) {
  const calls = { owner: 0, query: 0, members: 0, byName: 0 };
  const profiles = { [lower(OWNER)]: { pubkey: OWNER, display_name: "tal" } };
  if (holds) profiles[lower(holds)] = { pubkey: holds, display_name: "spike" };
  return {
    calls,
    // Rung 2's door. Answering nothing, deliberately: cell A must produce its
    // ownership sentence from rung 1 alone, and `calls.query` proves it.
    queryEvents: async () => {
      calls.query += 1;
      return [];
    },
    makeCli: () => ({
      async channelMembers() {
        calls.members += 1;
        return members.map((pubkey) => ({ pubkey, role: "member" }));
      },
      async getUser({ pubkey, name, owner }) {
        if (owner) {
          calls.owner += 1;
          return roster;
        }
        if (pubkey) return profiles[lower(pubkey)] ?? null;
        calls.byName += 1;
        return holds && lower(name) === "spike" ? profiles[lower(holds)] : null;
      },
    }),
  };
}

// A store that records every write, so "no key was generated" is asserted
// against the mechanism rather than against the sentence that claims it.
function store({ agentKeys = {} } = {}) {
  const calls = { create: 0, set: 0, remove: 0 };
  return {
    calls,
    keys: agentKeys,
    async getNodePrivateKey() {
      return NODE_SK;
    },
    async getAgentPrivateKey(name) {
      return agentKeys[name] ?? null;
    },
    async createAgentPrivateKey(name, secret) {
      calls.create += 1;
      if (agentKeys[name]) {
        const err = new Error("exists");
        err.exists = true;
        throw err;
      }
      agentKeys[name] = secret;
    },
    async setAgentPrivateKey(name, secret) {
      calls.set += 1;
      agentKeys[name] = secret;
    },
    async removeAgentPrivateKey(name) {
      calls.remove += 1;
      const had = Boolean(agentKeys[name]);
      delete agentKeys[name];
      return had;
    },
  };
}

// ── The wizard's own harness (FIX-181) ────────────────────────────────────
//
// `runSetup` takes a different store shape and writes a real config file, so
// it gets its own fixture rather than a branch inside the keygen one.

const NODE_PUBKEY = derivePubkey(NODE_SK);

const JOINED = {
  status: "joined",
  host: "relay.example",
  communityId: "kychee",
  origin: "https://relay.example",
  pubkey: NODE_PUBKEY,
  role: "member",
  displayName: "barry's hive",
};

function setupStore({ nodeKey = null, agentKeys = {} } = {}) {
  const made = [];
  return {
    made,
    keys: agentKeys,
    async getNodePrivateKey() {
      return nodeKey;
    },
    async createNodePrivateKey(_pubkey, k) {
      made.push("node");
      nodeKey = k;
    },
    async getAgentPrivateKey(name) {
      return agentKeys[name] ?? null;
    },
    async createAgentPrivateKey(name, k) {
      made.push(`agent:${name}`);
      agentKeys[name] = k;
    },
  };
}

function setupFixture({ joined = null } = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f037-setup-"));
  if (joined) writeJoinRecord({ stateDir, record: joined });
  const said = [];
  return {
    stateDir,
    said,
    configFile: path.join(stateDir, "hive402.config.json"),
    log: (l) => said.push(String(l)),
    writeConfig: (args) => {
      writeFileSync(args.file, `${JSON.stringify(starterConfig(args), null, 2)}\n`, "utf8");
      return args.file;
    },
  };
}

const stepState = (result, name) => result.steps.find((s) => s.name === name)?.state;
const stepDetail = (result, name) => result.steps.find((s) => s.name === name)?.detail ?? "";

// `bin/cli.mjs:466-471`, with the relay stubbed and nothing else.
async function runKeygen({ cfg, wire, st = store(), force = false, name = "spike" }) {
  const said = [];
  const log = (line) => said.push(String(line));
  const nameCheck = await makeNameCheck({
    config: cfg,
    stateDir: null,
    store: st,
    makeCli: wire.makeCli,
    resolveKey: async () => NODE_SK,
    queryEvents: wire.queryEvents,
    log,
  });
  let error = null;
  try {
    await keygen({
      store: st,
      target: { kind: "agent", name },
      force,
      log,
      nameCheck,
      generate: () => AGENT_SK,
    });
  } catch (err) {
    error = err;
  }
  return { said, out: said.join("\n"), error, store: st };
}

// ── CELL A — the finding ──────────────────────────────────────────────────

test("F-037 cell A: a config entry carrying the HOLDER's pubkey is a collision, not the caller", async () => {
  // The Red Team's construction, verbatim: the resolving config declares
  // `spike` with the pubkey that really holds the name, and its owner beside
  // it. On 0.3.4 this reported `"spike" is free in this room and on this
  // relay` and minted a real key into the OS credential store.
  const wire = relay({ members: [OWNER, HOLDER], holds: HOLDER });
  const run = await runKeygen({ cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }), wire });

  assert.ok(run.error, "a name the room resolves to another identity must refuse");
  assert.match(
    run.error.message,
    /already published in this room by 43e1b966aaaa…/,
    `the room question must name the holder. Got: ${run.error.message}`,
  );
  assert.doesNotMatch(run.out, /is free in this room/, "and must never claim the name is free");
});

test("F-037 cell A: the refusal names the clash as the owner's own, from rung 1 alone", async () => {
  // DD-69's rung 1 was dead on its clearest case: `ownerFromConfig` iterates
  // `refusals`, and the exclusion emptied that list before the ladder ran. A
  // pubkey declared in this very config WITH its owner beside it is the
  // cheapest, most certain same-owner attribution available.
  const wire = relay({ members: [OWNER, HOLDER], holds: HOLDER });
  const run = await runKeygen({ cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }), wire });

  assert.match(
    run.out,
    new RegExp(`you already have an agent called "spike" \\(${HOLDER.slice(0, 12)}…\\)`),
    `the owner must be told it is theirs. Got: ${run.out}`,
  );
  // The attribution must not depend on the relay at all. Rung 2's `/query` and
  // rung 3's `--owner` form are both allowed to be broken or unreachable here
  // — TR-022 says one of them IS — and the sentence must still appear.
  assert.equal(wire.calls.query, 0, "rung 1 answered, so /query is never asked");
  assert.equal(wire.calls.owner, 0, "…and the Desktop --owner lookup is never made");
});

// ── CELL B — the negative control, pinned byte for byte ───────────────────

test("F-037 cell B: a stranger's hold on the name refuses in exactly today's words", async () => {
  // Not in the config, so no channel and no owner: the relay-wide `@name`
  // question is the only one asked, and its wording is the thing every
  // cross-owner refusal has said since cycle 2. Pinned whole, not matched.
  const wire = relay({ holds: STRANGER });
  const run = await runKeygen({ cfg: config(), wire });

  assert.ok(run.error, "a name that resolves on the relay must refuse");
  assert.equal(
    run.error.message,
    `the name "spike" already resolves on this relay to ${STRANGER.slice(0, 12)}… — ` +
      `an agent registered into it would be admitted and unaddressable.\n` +
      `  No key was generated. Pick another name, or resolve the clash first.`,
  );
  assert.doesNotMatch(run.out, /you already have an agent/, "a stranger's agent is not the owner's");
});

// ── CELL C — the discriminator ────────────────────────────────────────────

test("F-037 cell C: a config entry with a DIFFERENT pubkey already refused, and still does", async () => {
  // This is what proves the diagnosis. The config entry is not poisonous in
  // itself — only the entry whose pubkey IS the holder was. C refused before
  // FIX-178 and refuses after it, unchanged, which is how we know the fix
  // targets the exclusion and not the config lookup.
  const wire = relay({ members: [OWNER, HOLDER], holds: HOLDER });
  const run = await runKeygen({ cfg: config({ pubkey: STALE, ownerPubkey: OWNER }), wire });

  assert.ok(run.error, "the room resolves the name to someone who is not the declared pubkey");
  assert.match(run.error.message, /already published in this room by 43e1b966aaaa…/);
  assert.equal(run.store.calls.create, 0, "and nothing is minted");
});

// ── CELL D — the over-correction guard ────────────────────────────────────

test("F-037 cell D: a declared name that resolves NOWHERE still proceeds", async () => {
  // The cell that would break every ordinary re-run. A config declares an
  // agent long before the relay knows it — and after a `--force` rotation the
  // config carries the new pubkey while the name is genuinely free. Refusing
  // because the name appears in the config is DD-70's rejected alternative 2,
  // and this is the test that catches it.
  const wire = relay({ members: [OWNER] });
  const run = await runKeygen({ cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }), wire });

  assert.equal(run.error, null, `a free name must mint. Got: ${run.error?.message}`);
  assert.equal(run.store.calls.create, 1, "the key is generated");
  assert.equal(run.store.keys.spike, AGENT_SK);
  assert.match(run.out, /generated a key for agent "spike"/);
});

test("F-037 cell D: --force rotation over a declared, unregistered name still rotates", async () => {
  // The same cell through the `--force` door, because that is the flow DD-70's
  // trade-off note is about: an operator replacing a key whose name nobody
  // else holds must not be blocked by their own config entry.
  const wire = relay({ members: [OWNER] });
  const run = await runKeygen({
    cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }),
    wire,
    st: store({ agentKeys: { spike: "2".repeat(64) } }),
    force: true,
  });

  assert.equal(run.error, null, `--force over a free name must rotate. Got: ${run.error?.message}`);
  assert.equal(run.store.calls.set, 1, "the key is replaced");
  assert.equal(run.store.keys.spike, AGENT_SK);
});

// ── The safety property, asserted at the store ────────────────────────────

test("F-037: no key is written on any refusing cell", async () => {
  // Against the mechanism, not the sentence. "No key was generated" is a
  // claim; `createAgentPrivateKey`/`setAgentPrivateKey` never being called is
  // the fact.
  const cells = [
    ["A", config({ pubkey: HOLDER, ownerPubkey: OWNER }), relay({ members: [OWNER, HOLDER], holds: HOLDER })],
    ["B", config(), relay({ holds: STRANGER })],
    ["C", config({ pubkey: STALE, ownerPubkey: OWNER }), relay({ members: [OWNER, HOLDER], holds: HOLDER })],
  ];
  for (const [cell, cfg, wire] of cells) {
    const run = await runKeygen({ cfg, wire });
    assert.ok(run.error, `cell ${cell} must refuse`);
    assert.equal(run.store.calls.create, 0, `cell ${cell} wrote a key with createAgentPrivateKey`);
    assert.equal(run.store.calls.set, 0, `cell ${cell} wrote a key with setAgentPrivateKey`);
    assert.equal(run.store.keys.spike, undefined, `cell ${cell} left a key behind`);
  }
});

// ── FIX-179 — a refusal does not say "Continuing anyway." ─────────────────

test("FIX-179: a refusing keygen does not say 'Continuing anyway'", async () => {
  // `makeNameCheck` rendered with `describeNameFindings`'s default
  // `continuing: true`, and `keygen` prints every warning BEFORE it throws on
  // the error — so cell A's run would print "Continuing anyway." directly
  // above "No key was generated." Unreachable until FIX-178 made the refusal
  // path able to carry a warning at all.
  const wire = relay({ members: [OWNER, HOLDER], holds: HOLDER });
  const run = await runKeygen({ cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }), wire });

  const whole = `${run.out}\n${run.error?.message ?? ""}`;
  assert.doesNotMatch(whole, /Continuing anyway/, "nothing continued: the command threw");
  assert.match(
    whole,
    /Nothing was created: retire that one, or give this agent a different name\./,
    "and the refusal uses the wording `register` already uses on its own refusal",
  );
});

test("FIX-179: a warning-only result still says 'Continuing anyway'", async () => {
  // The other half of the rule, and the reason it is one rule and not two
  // sentences. Here the name is free on the relay but the owner's Desktop
  // ROSTER holds it — rung 3, the only path to a warning without a refusal.
  // keygen really does continue, so the success wording is correct.
  const wire = relay({
    members: [OWNER],
    roster: { pubkey: DESKTOP, display_name: "spike" },
  });
  const run = await runKeygen({ cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }), wire });

  assert.equal(run.error, null, "a warning is not a refusal");
  assert.match(run.out, /you already have an agent called "spike"/);
  assert.match(run.out, /Continuing anyway\./);
  assert.equal(run.store.calls.create, 1, "and the key really was generated");
});

// ── FIX-180 — the "free" line claims only what was asked ──────────────────

test("FIX-180: 'free' does not claim a room that was never asked about", async () => {
  // For an ordinary keygen of a brand-new name `placeInConfig` returns no
  // channel, so `checkAgentName` SKIPS the room block entirely — and the line
  // still said `is free in this room and on this relay`. A second false
  // assurance in the same sentence as F-037's.
  const wire = relay({});
  const run = await runKeygen({ cfg: config(), wire });

  assert.equal(run.error, null);
  assert.equal(wire.calls.members, 0, "no channel was resolved, so no room was asked");
  assert.match(run.out, /name check: "spike" is free on this relay/);
  assert.doesNotMatch(run.out, /in this room/, "…so it must not say it asked one");
});

test("FIX-180: 'free' does name the room when a room really was asked", async () => {
  // The other side, so the fix is not "delete the words". Cell D resolves a
  // channel from the config and the room question really is asked.
  const wire = relay({ members: [OWNER] });
  const run = await runKeygen({ cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }), wire });

  assert.equal(run.error, null);
  assert.equal(wire.calls.members, 1, "a channel was resolved, so the room WAS asked");
  assert.match(run.out, /name check: "spike" is free in this room and on this relay/);
});

// ── FIX-182 — the stray key from an F-037 hit has a named way out ─────────

test("FIX-182: 'already has a key' names the command that clears one", async () => {
  // A user who hit F-037 on 0.3.4 holds an orphaned key. On 0.3.5 their next
  // `keygen --agent spike` hits `guardExisting` BEFORE the name check and gets
  // `alreadyHasKey`, whose only remedy was `--force` — which now correctly
  // refuses at the name check, leaving them with the stray key and no pointer.
  const wire = relay({ members: [OWNER, HOLDER], holds: HOLDER });
  const run = await runKeygen({
    cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }),
    wire,
    st: store({ agentKeys: { spike: "2".repeat(64) } }),
  });

  assert.ok(run.error);
  assert.match(run.error.message, /already has a key in the OS credential store/);
  assert.match(
    run.error.message,
    /hive402 keys remove --agent spike/,
    `the way out must be named. Got: ${run.error.message}`,
  );
  assert.match(run.error.message, /--force/, "and --force stays, for the deliberate replacement");
});

test("FIX-182: the command it names actually clears the entry", async () => {
  // The sentence alone is not the fix — a pointer to a command that does not
  // do what the sentence promises is worse than no pointer. Drive it.
  const st = store({ agentKeys: { spike: "2".repeat(64) } });
  const removed = await removePrivateKey({ store: st, target: { kind: "agent", name: "spike" } });

  assert.equal(removed, true, "it reports that something was removed");
  assert.equal(st.keys.spike, undefined, "and the entry is gone");

  // …and the keygen that was blocked now runs.
  const wire = relay({ members: [OWNER] });
  const run = await runKeygen({ cfg: config({ pubkey: HOLDER, ownerPubkey: OWNER }), wire, st });
  assert.equal(run.error, null, `after the removal the mint proceeds. Got: ${run.error?.message}`);
  assert.equal(derivePubkey(st.keys.spike), derivePubkey(AGENT_SK));
});

// ── FIX-181 — the third "before the agent exists" door ────────────────────
//
// `keygen`, `register` and `setup` all check a name before an identity exists.
// FIX-175 wired DD-69's ladder into the first two and left the third behind:
// `src/setup/run.mjs` called `checkAgentName` with no `config`, no `origin`
// and no key, so the ladder could not run there AT ALL and a same-owner
// collision got the ownership-blind wording F-036 was filed for — at a door
// the wizard sends every new operator through.
//
// Fixing two of three doors is the exact shape that has produced repeat
// findings in this project.

test("FIX-181: the setup wizard names a same-owner collision as the owner's own", async () => {
  const f = setupFixture({ joined: JOINED });
  const wire = relay({ members: [OWNER, HOLDER], holds: HOLDER });
  const result = await runSetup({
    store: setupStore({ nodeKey: NODE_SK }),
    stateDir: f.stateDir,
    configFile: f.configFile,
    // The owner's OTHER agent, in another room of this same hive — rung 1's
    // own case, and the cheapest attribution there is.
    config: config({ pubkey: HOLDER, ownerPubkey: OWNER }),
    agentName: "spike",
    ownerPubkey: OWNER,
    channel: CHANNEL,
    makeCli: wire.makeCli,
    queryEvents: wire.queryEvents,
    writeConfig: f.writeConfig,
    log: f.log,
    generate: () => AGENT_SK,
  });

  const out = f.said.join("\n");
  assert.equal(stepState(result, "agent"), "blocked", "the room resolves the name to another identity");
  assert.match(
    out,
    new RegExp(`you already have an agent called "spike" \\(${HOLDER.slice(0, 12)}…\\)`),
    `the wizard must say whose it is. Got: ${out}`,
  );
  assert.equal(wire.calls.query, 0, "rung 1 answered without a relay round trip");
});

test("FIX-181: the wizard's stranger collision is byte-identical to today's", async () => {
  // The negative control. A holder nobody can attribute to this owner must get
  // exactly the wording it got before the ladder was wired here — no ownership
  // claim, no new sentence.
  const f = setupFixture({ joined: JOINED });
  const wire = relay({ members: [OWNER, STRANGER], holds: STRANGER });
  const result = await runSetup({
    store: setupStore({ nodeKey: NODE_SK }),
    stateDir: f.stateDir,
    configFile: f.configFile,
    config: config(),
    agentName: "spike",
    ownerPubkey: OWNER,
    channel: CHANNEL,
    makeCli: wire.makeCli,
    queryEvents: wire.queryEvents,
    writeConfig: f.writeConfig,
    log: f.log,
    generate: () => AGENT_SK,
  });

  assert.equal(stepState(result, "agent"), "blocked");
  assert.equal(
    stepDetail(result, "agent"),
    `the name "spike" is already published in this room by ${STRANGER.slice(0, 12)}… — ` +
      `registering a second one would leave both unaddressable by name.`,
  );
  assert.doesNotMatch(f.said.join("\n"), /you already have an agent/);
});

test("FIX-181: the wizard's blocked path says nothing about continuing, and writes no key", async () => {
  // Same rule as FIX-179, at the door where it matters most: this arm returns
  // WITHOUT generating, so "Continuing anyway." is false — and it is printed
  // immediately above a report whose agent line reads "blocked".
  const f = setupFixture({ joined: JOINED });
  const wire = relay({ members: [OWNER, HOLDER], holds: HOLDER });
  const st = setupStore({ nodeKey: NODE_SK });
  await runSetup({
    store: st,
    stateDir: f.stateDir,
    configFile: f.configFile,
    config: config({ pubkey: HOLDER, ownerPubkey: OWNER }),
    agentName: "spike",
    ownerPubkey: OWNER,
    channel: CHANNEL,
    makeCli: wire.makeCli,
    queryEvents: wire.queryEvents,
    writeConfig: f.writeConfig,
    log: f.log,
    generate: () => AGENT_SK,
  });

  const out = f.said.join("\n");
  assert.doesNotMatch(out, /Continuing anyway/, "nothing continued: setup stopped at this step");
  assert.match(out, /Nothing was created: retire that one, or give this agent a different name\./);
  assert.deepEqual(st.made, [], "and no key was written — this is the arm that mints immediately after");
});

test("FIX-181: a free name still completes the wizard", async () => {
  // The over-correction guard for the third door: passing the config in must
  // not turn the wizard's own declared agent into a collision.
  const f = setupFixture({ joined: JOINED });
  const wire = relay({ members: [OWNER] });
  const st = setupStore({ nodeKey: NODE_SK });
  const result = await runSetup({
    store: st,
    stateDir: f.stateDir,
    configFile: f.configFile,
    config: config({ pubkey: HOLDER, ownerPubkey: OWNER }),
    agentName: "spike",
    ownerPubkey: OWNER,
    channel: CHANNEL,
    makeCli: wire.makeCli,
    queryEvents: wire.queryEvents,
    writeConfig: f.writeConfig,
    log: f.log,
    generate: () => AGENT_SK,
  });

  assert.equal(stepState(result, "agent"), "done", `the name is free. Steps: ${JSON.stringify(result.steps)}`);
  assert.deepEqual(st.made, ["agent:spike"]);
});
