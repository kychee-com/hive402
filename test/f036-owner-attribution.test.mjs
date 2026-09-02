// Whose agent is holding this name? (AC-56, F-036 round 2, FIX-175, DD-69.)
//
// ── The mock is the bug ────────────────────────────────────────────────────
//
// `test/f036-same-owner-collision.test.mjs` is green and the product is
// broken, and one line explains both:
//
//     async getUser({ pubkey, name, owner }) {
//       if (owner) return ownedByOwner ? profiles[holder] : null;
//
// That mock answers an owner-scoped lookup. **The relay never does.** `buzz
// users get --name <n> --owner <hex>` queries `{kinds:[30177],
// authors:[owner]}` — the managed-agent roster records only Buzz Desktop
// publishes (`crates/buzz-cli/src/commands/users.rs:128-139`, buzz
// `eed74bde2`) — matches on `content.name` and returns their `d` tags.
// `publisher.mjs` deliberately writes no 30177 record, so a hive402-hosted
// agent has no row in that table and the command returns `[]` before any
// ownership code runs. Correct owner and wrong owner return the same empty
// array.
//
// So every case below drives a `getUser` that returns `null` **whenever
// `owner` is set**, which is what the relay really does, and the same-owner
// case reads ownership-blind until the DD-69 ladder lands.
//
// ── The ladder, and the one rung that is an attack surface ────────────────
//
//   1. this hive's config      — the holder is listed here, with an owner
//   2. the holder's kind-0 NIP-OA `auth` tag, VERIFIED, fetched raw through
//      the node's `/query` door
//   3. the Desktop roster      — the existing `--owner` call, unchanged
//   4. no claim
//
// Rung 2 is the one that reaches F-036's actual scenario, and it is the one
// that has to be a signature rather than a string. The obvious cheap version —
// read the `about` line, which really does say `hive402 agent · hosted by
// 71a12235e894…` — would make hive402's own message forgeable: a stranger who
// writes the victim's prefix into their own `about` gets introduced to that
// victim as their own agent. That case is `FORGERY` below and it is mandatory.
//
// Measured live before any of this was written (rig, 2026-09-01), which is the
// whole point of the cycle:
//
//   POST /query [{"kinds":[0],"authors":["43e1b966…"]}]  ->  1 event
//   { content, created_at, id, kind, pubkey, sig, tags }
//   tags: [["auth","71a12235e894…","","be9559cb…"]]
//   verifyAuthTag -> 71a12235e894…  (= the claimed owner)
//
// The fixtures below are that shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerAgent } from "../src/node/runtime.mjs";
import { checkAgentName, describeNameFindings } from "../src/registry/namecheck.mjs";
import { makeNameCheck } from "../src/registry/namecheckcommand.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
// Another human, with a real key, so their attestations really verify — to
// somebody else. This is rung 4: a signed record naming an owner who is not
// the caller, which must produce NO claim rather than a wrong one.
const OTHER_SK = "4f9a1c2e6b8d3705a1e4c79b2d58f306e9c4b17a5d2e8f043b6c9a17e5d20c8b";
const OTHER = "6ddc0785c13b2bea771fdf931055fe393d59e265f0d4c92c72a93a78f0d195a7";

const STRANGER = "c0ffee00".padEnd(64, "c");
// The owner's own agent, holding the name somewhere this node has never seen.
const MINE = "16df7761".padEnd(64, "a");
// The identity being registered now.
const NEW_AGENT = "97eb472b".padEnd(64, "b");
const CHANNEL = "6f30305c-7903-42e4-912e-502ceedf15b8";
const ORIGIN = "http://localhost:3000";

// A kind-0 as the relay serves it: content is a JSON STRING, tags survive.
function profileEvent({ pubkey, name, about, authTag = null }) {
  return {
    id: "e".repeat(64),
    kind: 0,
    pubkey,
    created_at: 1788287874,
    content: JSON.stringify({ about, display_name: name, picture: "https://hive402.com/avatar.svg" }),
    tags: authTag ? [authTag] : [],
    sig: "f".repeat(128),
  };
}

const attest = (ownerSk, agentPubkey) =>
  computeAuthTag({ ownerPrivateKey: ownerSk, agentPubkey });

// ── The relay, as it actually answers ─────────────────────────────────────
//
// `owner` scoped -> null, always. `events` is what `/query` returns for a
// kind-0 authors filter. `calls` records what was asked, so a test can assert
// that a cheaper rung short-circuited the expensive one.
function relayWhere({ holder, event = null }) {
  const calls = { owner: 0, query: 0 };
  const profiles = {
    [OWNER]: { pubkey: OWNER, display_name: "tal" },
    [holder]: { pubkey: holder, display_name: "probe1" },
  };
  return {
    calls,
    queryEvents: async ({ filters }) => {
      calls.query += 1;
      const wanted = (filters?.[0]?.authors ?? []).map((a) => a.toLowerCase());
      if (!event) return [];
      return wanted.includes(event.pubkey.toLowerCase()) ? [event] : [];
    },
    makeCli: () => ({
      async channelMembers() {
        return [{ pubkey: OWNER, role: "member" }];
      },
      async getUser({ pubkey, name, owner }) {
        // THE CORRECTION. A hive402-hosted agent has no kind-30177 record, so
        // the owner-scoped form returns nothing for it — every time, for the
        // right owner and the wrong one alike.
        if (owner) {
          calls.owner += 1;
          return null;
        }
        if (pubkey) return profiles[String(pubkey).toLowerCase()] ?? null;
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

const config = (extraAgents = []) => ({
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
        ...extraAgents,
      ],
    },
  ],
});

const register = (relay, cfg = config()) =>
  registerAgent({
    config: cfg,
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-f036b-")),
    agentName: "probe1",
    sponsorRef: "env:OWNER_KEY",
    ownerKeyRef: "env:OWNER_KEY",
    resolveKey: async () => OWNER_SK,
    makeCli: relay.makeCli,
    queryEvents: relay.queryEvents,
  });

const refusalFrom = async (relay, cfg = config()) => {
  try {
    await register(relay, cfg);
    assert.fail("the registration should have been refused");
  } catch (err) {
    return err.message;
  }
};

const STRANGER_REFUSAL =
  `registration refused: agent name "probe1" already resolves on this relay to ` +
  `${STRANGER.slice(0, 12)}… — registering it would leave both unaddressable by name`;

// ── RED: the case F-036 actually reports ──────────────────────────────────

test("FIX-175: a same-owner collision the relay will not scope still says it is the owner's own", async () => {
  // The owner's agent, attested by the owner, holding the name — and the
  // `--owner` lookup answers `[]` because that is what it does. Before DD-69
  // this refusal is byte-identical to a stranger's.
  const relay = relayWhere({
    holder: MINE,
    event: profileEvent({
      pubkey: MINE,
      name: "probe1",
      about: `hive402 agent · hosted by ${OWNER.slice(0, 12)}…`,
      authTag: attest(OWNER_SK, MINE),
    }),
  });
  const message = await refusalFrom(relay);
  assert.match(message, /registration refused/, "it is still a refusal");
  assert.match(
    message,
    new RegExp(`you already have an agent called "probe1" \\(${MINE.slice(0, 12)}…\\)`, "i"),
    `the attestation names the owner and the sentence must use it. Got: ${message}`,
  );
  assert.notEqual(message, STRANGER_REFUSAL, "…and must differ from the cross-owner wording");
  assert.equal(relay.calls.owner, 0, "rung 2 answered, so the Desktop lookup is not made");
});

test("FIX-175: the same rung answers at keygen, before the agent exists", async () => {
  // AC-56's "before the agent exists" half lands in `makeNameCheck`. Wiring
  // only `registerAgent` leaves keygen ownership-blind and regresses the
  // criterion to the later of its two moments.
  const relay = relayWhere({
    holder: MINE,
    event: profileEvent({
      pubkey: MINE,
      name: "probe1",
      about: "anything at all",
      authTag: attest(OWNER_SK, MINE),
    }),
  });
  const check = await makeNameCheck({
    config: config(),
    stateDir: null,
    store: { getNodePrivateKey: async () => OWNER_SK },
    makeCli: relay.makeCli,
    resolveKey: async () => OWNER_SK,
    queryEvents: relay.queryEvents,
    log: null,
  });
  const said = await check("probe1");
  assert.equal(said.warnings.length, 1, `keygen must say it too. Got: ${JSON.stringify(said)}`);
  assert.match(said.warnings[0], /you already have an agent called "probe1"/i);

  // ── This line read `/continuing anyway/i, "keygen proceeds — unchanged"` ──
  //
  // It does not proceed. `MINE` holds the name relay-wide, so this result
  // carries a REFUSAL as well as the warning and `keygen` throws on it — the
  // assertion was describing a run that stops. The test never checked
  // `said.error`, which is exactly how it stayed green while pinning the wrong
  // sentence, and it is the third thing F-037's repro turned up (FIX-179):
  // warnings print BEFORE the throw, so this run said "Continuing anyway."
  // directly above "No key was generated."
  //
  // Both halves asserted now, so the pair cannot drift apart again.
  assert.ok(said.error, "this name IS held on the relay, so the run refuses");
  assert.match(
    said.warnings[0],
    /Nothing was created: retire that one, or give this agent a different name\./,
    "a refusal uses the refusal wording",
  );
  assert.doesNotMatch(said.warnings[0], /continuing anyway/i);
});

// ── Rung 1: this hive's own config, with no relay call at all ─────────────

test("FIX-175: a second agent of mine in another room of this hive is attributed from the config", async () => {
  const cfg = config([
    {
      name: "probe1-old",
      pubkey: MINE,
      ownerPubkey: OWNER,
      privateKeyRef: "env:OLD",
      research: false,
      build: false,
      crossOwnerAsks: "owner-approves",
      selfInitiated: "asks-owner",
      replyMode: "addressed-only",
    },
  ]);
  const relay = relayWhere({ holder: MINE, event: null });
  const message = await refusalFrom(relay, cfg);
  assert.match(message, /you already have an agent called "probe1"/i, `Got: ${message}`);
  assert.equal(relay.calls.query, 0, "rung 1 is free: no relay round trip");
  assert.equal(relay.calls.owner, 0, "…and no Desktop lookup either");
});

// ── Rung 4, twice: no claim beats a wrong claim ───────────────────────────

test("NEGATIVE CONTROL: a stranger's collision keeps today's wording, byte for byte", async () => {
  const relay = relayWhere({
    holder: STRANGER,
    event: profileEvent({
      pubkey: STRANGER,
      name: "probe1",
      about: `hive402 agent · hosted by ${OTHER.slice(0, 12)}…`,
      authTag: attest(OTHER_SK, STRANGER),
    }),
  });
  const message = await refusalFrom(relay);
  assert.equal(message, STRANGER_REFUSAL);
});

test("NEGATIVE CONTROL: an agent attested by ANOTHER node names no owner of ours", async () => {
  // A real, verifying attestation — by somebody else. hive402 knows whose it
  // is and it is not the caller's, so it says nothing rather than guessing.
  const relay = relayWhere({
    holder: STRANGER,
    event: profileEvent({
      pubkey: STRANGER,
      name: "probe1",
      about: "hive402 agent",
      authTag: attest(OTHER_SK, STRANGER),
    }),
  });
  const message = await refusalFrom(relay);
  assert.doesNotMatch(message, /you already have/i);
  assert.doesNotMatch(message, /your own/i);
});

test("FORGERY: the owner's prefix written into a stranger's `about` is NOT ownership", async () => {
  // The attack the cheap version would have opened. The `about` string is
  // unsigned display text that any identity can set to anything, and AC-35
  // requires identification by verifiable attestation "never via display
  // name". Here it says exactly what a genuine hive402 profile says — and the
  // signature on the profile is the stranger's own owner's, not ours.
  const relay = relayWhere({
    holder: STRANGER,
    event: profileEvent({
      pubkey: STRANGER,
      name: "probe1",
      about: `hive402 agent · hosted by ${OWNER.slice(0, 12)}…`,
      authTag: attest(OTHER_SK, STRANGER),
    }),
  });
  const message = await refusalFrom(relay);
  assert.equal(
    message,
    STRANGER_REFUSAL,
    "a forged `about` must not introduce a stranger's agent to the victim as their own",
  );
});

test("FORGERY: an UNSIGNED profile carrying the owner's prefix is NOT ownership either", async () => {
  // No tag at all — the weaker forgery, and the one a string-matching
  // implementation would fall for hardest.
  const relay = relayWhere({
    holder: STRANGER,
    event: profileEvent({
      pubkey: STRANGER,
      name: "probe1",
      about: `hive402 agent · hosted by ${OWNER.slice(0, 12)}…`,
      authTag: null,
    }),
  });
  assert.equal(await refusalFrom(relay), STRANGER_REFUSAL);
});

test("FORGERY: a STOLEN auth tag pasted onto a stranger's profile does not verify", async () => {
  // The wire format's own defence (`nipoa.mjs`): the agent pubkey is inside
  // the preimage but not inside the tag, so a tag lifted from the owner's real
  // agent stops matching when it is found on a different pubkey. Pinned here
  // because this ladder is the first thing to read tags off profiles it did
  // not publish.
  const relay = relayWhere({
    holder: STRANGER,
    event: profileEvent({
      pubkey: STRANGER,
      name: "probe1",
      about: "hive402 agent",
      authTag: attest(OWNER_SK, MINE), // the owner's tag, for a DIFFERENT agent
    }),
  });
  assert.equal(await refusalFrom(relay), STRANGER_REFUSAL);
});

// ── The seam, directly: shapes the callers cannot easily produce ──────────

test("FIX-175: the ladder falls through to the Desktop roster when nothing is attested", async () => {
  // Rung 3 is kept, unchanged. It is the only source that can answer AC-56's
  // literal "the owner's own clients", and it starts answering the moment a
  // Desktop-made agent is the thing being collided with.
  let asked = null;
  const cli = {
    async channelMembers() {
      return [];
    },
    async getUser({ name, owner }) {
      if (owner) {
        asked = { name, owner };
        return { pubkey: MINE, display_name: "probe1" };
      }
      return null;
    },
  };
  const findings = await checkAgentName({
    cli,
    name: "probe1",
    channel: null,
    selfPubkey: NEW_AGENT,
    ownerPubkey: OWNER,
  });
  assert.deepEqual(asked, { name: "probe1", owner: OWNER }, "the existing lookup is still made");
  assert.equal(findings.warnings.length, 1);
  assert.equal(findings.warnings[0].pubkey, MINE);
});

test("FIX-175: rung 2 is skipped, not faked, when there is no door to ask through", async () => {
  // No origin and no key — `keygen` before a join, offline. The ladder may
  // decline to add a sentence; it may never claim one it did not verify, and
  // it may never turn a refusal into a failed check.
  const cli = {
    async channelMembers() {
      return [];
    },
    async getUser({ owner }) {
      return owner ? null : { pubkey: MINE, display_name: "probe1" };
    },
  };
  const findings = await checkAgentName({
    cli,
    name: "probe1",
    channel: null,
    selfPubkey: NEW_AGENT,
    ownerPubkey: OWNER,
    queryEvents: async () => {
      assert.fail("no origin and no key: the door must not be opened at all");
    },
  });
  assert.equal(findings.checked, true, "the refusal question was still answered");
  assert.equal(findings.refusals.length, 1);
  assert.equal(findings.warnings.length, 0, "and no ownership is claimed");
});

test("FIX-175: a relay that refuses the QUERY does not break the refusal", async () => {
  // The query door is an addition. If it throws, the name check still has its
  // answer from the room and the relay, and must still refuse — a failed
  // attribution is not a failed check.
  const cli = {
    async channelMembers() {
      return [];
    },
    async getUser({ owner }) {
      return owner ? null : { pubkey: MINE, display_name: "probe1" };
    },
  };
  const findings = await checkAgentName({
    cli,
    name: "probe1",
    channel: null,
    selfPubkey: NEW_AGENT,
    ownerPubkey: OWNER,
    origin: ORIGIN,
    privateKeyHex: OWNER_SK,
    queryEvents: async () => {
      throw new Error("the relay refused the query (HTTP 403)");
    },
  });
  assert.equal(findings.checked, true, "still checked — the refusal stands");
  assert.equal(findings.refusals.length, 1);
  assert.equal(findings.warnings.length, 0, "and claims nothing");
});

test("NEGATIVE CONTROL: could-not-check still fails LOUD, never 'there is nothing there'", async () => {
  const cli = {
    async channelMembers() {
      return [];
    },
    async getUser() {
      throw new Error("relay unreachable");
    },
  };
  const findings = await checkAgentName({
    cli,
    name: "probe1",
    channel: null,
    selfPubkey: NEW_AGENT,
    ownerPubkey: OWNER,
    origin: ORIGIN,
    privateKeyHex: OWNER_SK,
    queryEvents: async () => [],
  });
  assert.equal(findings.checked, false);
  const said = describeNameFindings({ name: "probe1", findings });
  assert.match(said.warnings[0], /could not check/i);
  assert.doesNotMatch(said.warnings.join(" "), /you already have/i);
});
