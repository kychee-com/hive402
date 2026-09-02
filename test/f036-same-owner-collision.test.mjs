// A name collision with the owner's OWN agent says so (AC-56, F-036, FIX-171).
//
// ── The product already knew, and the sentence that needed it never asked ──
//
// This is the defect class the plan has recorded three times now. `register`
// ALREADY asks the owner-scoped question — `checkAgentName` with the agent's
// `ownerPubkey`, at `runtime.mjs:456` — and already turns the answer into the
// right wording, "you already have an agent called …". Nine lines later:
//
//     if (!verdict.ok) throw new Error(`registration refused: ${verdict.reason}`);
//
// …and `ownerNameWarnings` is dropped on the floor. The sentence is composed
// for every registration and thrown away by the one branch that needed it. The
// refusal that survives comes from `validateRegistration`, which is
// ownership-blind BY CONSTRUCTION: it prints a bare pubkey prefix and cannot
// tell the caller's own agent from a stranger's.
//
// ── There are TWO suppressions, and either one alone leaves it unfixed ─────
//
// `namecheck.mjs` will not even RECORD the ownership when the same pubkey is
// already a refusal:
//
//     if (mine && mine !== self && !refusals.some((r) => r.pubkey === mine)) {
//
// A relay-wide `@name` hit and "this is your own agent" are not alternatives.
// The second is strictly more informative, and the dedup that drops it is the
// reason a same-owner collision reads byte-for-byte like a stranger's. Fixing
// only `runtime.mjs` would carry an empty list; fixing only `namecheck.mjs`
// would fill a list nobody reads. Both are in the RED below.
//
// ── The negative control is the whole of the Red Team's ask ────────────────
//
// "Keep the cross-owner wording intact." Without that pin this fix degrades
// into "say 'your own agent' always", which would be a worse message than the
// one being replaced — it would be wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerAgent } from "../src/node/runtime.mjs";
import { checkAgentName, describeNameFindings } from "../src/registry/namecheck.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const STRANGER = "c0ffee00".padEnd(64, "c");
// The owner's OWN agent, made in Buzz Desktop under their own key. Neither a
// room clash nor another owner's node: the owner colliding with themselves.
const MINE = "16df7761".padEnd(64, "a");
// The identity being registered now.
const NEW_AGENT = "97eb472b".padEnd(64, "b");
const CHANNEL = "6f30305c-7903-42e4-912e-502ceedf15b8";

// A relay where the room is GENUINELY EMPTY of this name — no member of the
// channel publishes it — and the only claim is a global `@name` resolution.
// That is F-036's exact shape: the room says nothing, the relay says "taken",
// and only the owner-scoped question can say by whom.
function relayWhere({ holder, ownedByOwner }) {
  const profiles = {
    [OWNER]: { pubkey: OWNER, display_name: "tal" },
    [holder]: { pubkey: holder, display_name: "probe1" },
  };
  return {
    makeCli: () => ({
      async channelMembers() {
        return [{ pubkey: OWNER, role: "member" }];
      },
      async getUser({ pubkey, name, owner }) {
        if (pubkey) return profiles[String(pubkey).toLowerCase()] ?? null;
        // The owner-scoped lookup upstream supplies for exactly this question:
        // `buzz users get --name <n> --owner <hex>`.
        if (owner) return ownedByOwner ? profiles[holder] : null;
        const wanted = String(name).toLowerCase();
        return Object.values(profiles).find((p) => p.display_name.toLowerCase() === wanted) ?? null;
      },
      async addChannelMember() {
        return { accepted: true };
      },
      async setProfile() {
        return { accepted: true };
      },
      async joinChannel() {
        return { accepted: true };
      },
    }),
  };
}

const config = () => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: OWNER, privateKeyRef: "env:K" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:/Buzz", nodeDir: "C:/node", adapter: "C:/adapter.js", extraDirs: [] },
  rooms: [
    {
      channel: CHANNEL,
      agents: [
        {
          name: "probe1",
          pubkey: NEW_AGENT,
          ownerPubkey: OWNER,
          privateKeyRef: "env:NEW_AGENT_KEY",
          research: false,
          build: false,
          crossOwnerAsks: "owner-approves",
          selfInitiated: "asks-owner",
          replyMode: "addressed-only",
        },
      ],
    },
  ],
});

const register = (relay) =>
  registerAgent({
    config: config(),
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-f036-")),
    agentName: "probe1",
    sponsorRef: "env:OWNER_KEY",
    ownerKeyRef: "env:OWNER_KEY",
    resolveKey: async () => OWNER_SK,
    makeCli: relay.makeCli,
  });

const refusalFrom = async (relay) => {
  try {
    await register(relay);
    assert.fail("the registration should have been refused");
  } catch (err) {
    return err.message;
  }
};

// ── The three cases, tested separately ─────────────────────────────────────

test("F-036: a same-owner collision SAYS it is the owner's own agent", async () => {
  const message = await refusalFrom(relayWhere({ holder: MINE, ownedByOwner: true }));
  assert.match(message, /registration refused/, "it is still a refusal");
  assert.match(
    message,
    /you already have an agent called/i,
    `the owner-scoped fact is the informative one, and it was computed. Got: ${message}`,
  );
});

test("F-036: …and names WHICH agent, so the owner can go and find it", async () => {
  // Written the loose way first — /probe1/ and the pubkey prefix — this passed
  // against the UNFIXED product, because the ownership-blind refusal already
  // prints both. The name and the key are not what was missing. The SENTENCE
  // that attributes them to the owner is, so that is what this asserts.
  const message = await refusalFrom(relayWhere({ holder: MINE, ownedByOwner: true }));
  assert.match(
    message,
    new RegExp(`you already have an agent called "probe1" \\(${MINE.slice(0, 12)}…\\)`, "i"),
    `Got: ${message}`,
  );
});

test("F-036: the same-owner refusal does not read as 'continuing anyway'", async () => {
  // The wording that already existed was written for the SUCCESS path, where
  // the registration proceeds despite the warning. Pasted verbatim onto a
  // refusal it would say "Continuing anyway" about a command that created
  // nothing, which is worse than the ownership-blind line it replaces.
  const message = await refusalFrom(relayWhere({ holder: MINE, ownedByOwner: true }));
  assert.doesNotMatch(message, /continuing anyway/i);
});

test("NEGATIVE CONTROL: a STRANGER's collision keeps today's wording, byte for byte", async () => {
  // The whole of the Red Team's "keep the cross-owner wording intact", and the
  // control that stops this fix becoming "say 'your own agent' always".
  const message = await refusalFrom(relayWhere({ holder: STRANGER, ownedByOwner: false }));
  assert.equal(
    message,
    `registration refused: agent name "probe1" already resolves on this relay to ` +
      `${STRANGER.slice(0, 12)}… — registering it would leave both unaddressable by name`,
  );
});

test("NEGATIVE CONTROL: a stranger's collision never claims the owner owns it", async () => {
  const message = await refusalFrom(relayWhere({ holder: STRANGER, ownedByOwner: false }));
  assert.doesNotMatch(message, /you already have/i);
  assert.doesNotMatch(message, /your own/i);
});

test("NEGATIVE CONTROL: could-not-check still fails LOUD, never 'there is nothing there'", async () => {
  // F-008's cause, and the standing rule this whole family is written under.
  // A relay that cannot be read must refuse, and must say it could not read —
  // never report an empty result as an absence of clashes.
  //
  // The membership read succeeds and only the NAME lookups fail. That is the
  // interesting shape: the sponsor is a member, the registration is otherwise
  // in order, and the single thing that cannot be established is whether the
  // name is free. Failing the whole relay would prove nothing about this
  // branch, because `registerAgent` reads the roster before it ever asks about
  // a name.
  const unreadable = {
    makeCli: () => ({
      async channelMembers() {
        return [{ pubkey: OWNER, role: "member" }];
      },
      async getUser() {
        throw new Error("relay unreachable");
      },
      async addChannelMember() {
        return { accepted: true };
      },
      async setProfile() {
        return { accepted: true };
      },
      async joinChannel() {
        return { accepted: true };
      },
    }),
  };
  const message = await refusalFrom(unreadable);
  assert.match(message, /could not/i, `a failed check must say so. Got: ${message}`);
  assert.doesNotMatch(message, /you already have/i, "and must claim no ownership it could not verify");
});

// ── The first suppression, at its own level ────────────────────────────────

test("FIX-171: namecheck records ownership even when that pubkey is ALSO a refusal", async () => {
  // The dedup's original job is not reporting one clash twice. Its side effect
  // was dropping the strictly-more-informative fact, which is what made a
  // same-owner collision indistinguishable from a stranger's.
  const cli = {
    async channelMembers() {
      return [];
    },
    async getUser({ name, owner }) {
      return { pubkey: MINE, display_name: "probe1" };
    },
  };
  const findings = await checkAgentName({
    cli,
    name: "probe1",
    channel: null,
    selfPubkey: NEW_AGENT,
    ownerPubkey: OWNER,
  });
  assert.equal(findings.refusals.length, 1, "the relay-wide clash is still recorded");
  assert.equal(
    findings.warnings.length,
    1,
    "…AND so is the ownership. They are not alternatives; the second is more informative",
  );
  assert.equal(findings.warnings[0].pubkey, MINE);
});

test("FIX-171: the refusal wording is refusal-shaped, the keygen wording is unchanged", async () => {
  // One source of wording for both callers (that is why `describeNameFindings`
  // exists), and one flag for the only thing that genuinely differs: whether
  // the command is about to continue.
  const findings = {
    checked: true,
    reason: null,
    refusals: [],
    warnings: [{ scope: "owner", pubkey: MINE, name: "probe1" }],
  };
  const keygen = describeNameFindings({ name: "probe1", findings }).warnings[0];
  const refused = describeNameFindings({ name: "probe1", findings, continuing: false }).warnings[0];

  assert.match(keygen, /continuing anyway/i, "keygen proceeds, and says so — unchanged");
  assert.doesNotMatch(refused, /continuing anyway/i, "a refusal created nothing");
  assert.match(refused, /you already have an agent called "probe1"/);
});
