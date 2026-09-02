import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, DEFAULT_AGENT_SETTINGS } from "../src/config/schema.mjs";

const minimal = {
  relayUrl: "wss://relay.example",
  // The node is a room member in its own right: it publishes wakes and answers
  // chat-native queries under this identity.
  node: { pubkey: "9".repeat(64) },
  rooms: [
    {
      channel: "11111111-1111-1111-1111-111111111111",
      respondTo: "anyone",
      agents: [{ name: "blitz", pubkey: "b".repeat(64), ownerPubkey: "a".repeat(64) }],
    },
  ],
};

test("a minimal config parses and fills the six settings with spec presets", () => {
  const cfg = parseConfig(minimal);
  const agent = cfg.rooms[0].agents[0];
  assert.equal(agent.replyMode, "well-mannered");
  assert.equal(agent.crossOwnerAsks, "owner-approves");
  assert.equal(agent.selfInitiated, "asks-owner");
  assert.equal(agent.research, false); // newcomers start off (AC-22)
  assert.equal(agent.build, false);
});

test("the settings surface is exactly the six owner-facing settings (AC-18)", () => {
  assert.deepEqual(Object.keys(DEFAULT_AGENT_SETTINGS).sort(), [
    "build",
    "crossOwnerAsks",
    "replyMode",
    "research",
    "selfInitiated",
  ].sort());
  // `name` is the sixth, supplied per agent rather than defaulted
  const cfg = parseConfig(minimal);
  assert.equal(cfg.rooms[0].agents[0].name, "blitz");
});

test("explicit settings override the presets", () => {
  const cfg = parseConfig({
    ...minimal,
    rooms: [
      {
        ...minimal.rooms[0],
        agents: [
          {
            name: "blitz",
            pubkey: "b".repeat(64),
            ownerPubkey: "a".repeat(64),
            replyMode: "addressed-only",
            research: true,
            build: true,
          },
        ],
      },
    ],
  });
  const agent = cfg.rooms[0].agents[0];
  assert.equal(agent.replyMode, "addressed-only");
  assert.equal(agent.research, true);
  assert.equal(agent.build, true);
});

test("agent names must be unique per room (AC-37)", () => {
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        rooms: [
          {
            ...minimal.rooms[0],
            agents: [
              { name: "blitz", pubkey: "b".repeat(64), ownerPubkey: "a".repeat(64) },
              { name: "Blitz", pubkey: "c".repeat(64), ownerPubkey: "b".repeat(64) },
            ],
          },
        ],
      }),
    /unique|duplicate/i,
  );
});

test("an unknown setting is rejected rather than silently ignored", () => {
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        rooms: [
          {
            ...minimal.rooms[0],
            agents: [{ name: "blitz", pubkey: "b".repeat(64), ownerPubkey: "a".repeat(64), personality: "sassy" }],
          },
        ],
      }),
    /unknown setting|personality/i,
  );
});

test("an invalid setting value is rejected", () => {
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        rooms: [
          {
            ...minimal.rooms[0],
            agents: [{ name: "blitz", pubkey: "b".repeat(64), ownerPubkey: "a".repeat(64), replyMode: "chatty" }],
          },
        ],
      }),
    /replyMode/i,
  );
});

test("owner pubkey must be 64-char hex", () => {
  assert.throws(
    () =>
      parseConfig({
        ...minimal,
        rooms: [{ ...minimal.rooms[0], agents: [{ name: "blitz", pubkey: "b".repeat(64), ownerPubkey: "nope" }] }],
      }),
    /pubkey/i,
  );
});

test("config must define at least one room with one agent", () => {
  assert.throws(() => parseConfig({ relayUrl: "wss://r", rooms: [] }), /room/i);
});

// --- F-022 (fix cycle 13), DD-40: npub is accepted for a PUBLIC key ---------
//
// The config is where a user copies their pubkey to, and what Buzz shows them
// is an `npub1…`. Normalising here rather than at every reader means nothing
// downstream changes: `pubkey` is 64-char hex by the time anyone sees it.

const { hexToBech32, corrupt } = await import("../fixtures/bech32-encode.mjs");

const AGENT_HEX = "b".repeat(64);
const OWNER_HEX = "a".repeat(64);
const NODE_HEX = "9".repeat(64);

const withKeys = ({ node = NODE_HEX, pubkey = AGENT_HEX, ownerPubkey = OWNER_HEX }) => ({
  ...minimal,
  node: { pubkey: node },
  rooms: [{ ...minimal.rooms[0], agents: [{ name: "blitz", pubkey, ownerPubkey }] }],
});

test("an agent pubkey written as npub is accepted and normalised to hex (F-022)", () => {
  const cfg = parseConfig(withKeys({ pubkey: hexToBech32("npub", AGENT_HEX) }));
  assert.equal(cfg.rooms[0].agents[0].pubkey, AGENT_HEX);
});

test("ownerPubkey and node.pubkey take npub too (F-022)", () => {
  const cfg = parseConfig(
    withKeys({
      node: hexToBech32("npub", NODE_HEX),
      ownerPubkey: hexToBech32("npub", OWNER_HEX),
    }),
  );
  assert.equal(cfg.node.pubkey, NODE_HEX);
  assert.equal(cfg.rooms[0].agents[0].ownerPubkey, OWNER_HEX);
});

test("an uppercase hex pubkey is folded to lowercase, one canonical form (F-022)", () => {
  const cfg = parseConfig(withKeys({ pubkey: AGENT_HEX.toUpperCase() }));
  assert.equal(cfg.rooms[0].agents[0].pubkey, AGENT_HEX);
});

// The reason normalisation happens BEFORE the identity comparisons rather than
// after: an npub and its own hex are the same identity, and every one of these
// checks exists to catch exactly that collision.

test("an npub agent and its hex twin are caught as ONE identity (F-022)", () => {
  const two = {
    ...minimal,
    rooms: [
      {
        ...minimal.rooms[0],
        agents: [
          { name: "blitz", pubkey: AGENT_HEX, ownerPubkey: OWNER_HEX },
          { name: "spark", pubkey: hexToBech32("npub", AGENT_HEX), ownerPubkey: OWNER_HEX },
        ],
      },
    ],
  };
  assert.throws(() => parseConfig(two), /share the pubkey/);
});

test("self-attestation is caught across the two written forms (F-022)", () => {
  assert.throws(
    () => parseConfig(withKeys({ pubkey: AGENT_HEX, ownerPubkey: hexToBech32("npub", AGENT_HEX) })),
    /may not be its own owner/,
  );
});

test("an agent reusing the node identity is caught across forms (F-022)", () => {
  assert.throws(
    () => parseConfig(withKeys({ pubkey: hexToBech32("npub", NODE_HEX) })),
    /uses the node identity/,
  );
});

// --- and the branch that matters most: a PRIVATE key in a public field ------

test("an nsec in a pubkey field is refused AS A PRIVATE KEY, value-free (F-022)", () => {
  // Before this fix it fell through a generic "must be 64-char hex", which is
  // safe but says nothing about the fact that a live private key is now sitting
  // in a plaintext file.
  for (const field of ["pubkey", "ownerPubkey"]) {
    const written = hexToBech32("nsec", AGENT_HEX);
    const err = (() => {
      try {
        parseConfig(withKeys({ [field]: written }));
        return null;
      } catch (failure) {
        return failure;
      }
    })();

    assert.ok(err, `${field} must refuse an nsec`);
    assert.match(err.message, /private/i, `${field}: say what they pasted`);
    assert.match(err.message, /config file|never be written/i, `${field}: say why it matters`);
    assert.ok(!err.message.includes(written), `${field}: the refusal must not echo it`);
    assert.ok(!err.message.includes(AGENT_HEX), `${field}: nor anything decoded from it`);
  }
});

test("a corrupted npub is refused by its checksum, not silently truncated (F-022)", () => {
  const broken = corrupt(hexToBech32("npub", AGENT_HEX));
  const err = (() => {
    try {
      parseConfig(withKeys({ pubkey: broken }));
      return null;
    } catch (failure) {
      return failure;
    }
  })();
  assert.ok(err);
  assert.match(err.message, /checksum/i);
  assert.ok(!err.message.includes(broken));
});

test("a plain wrong pubkey still gets the old, clear refusal (F-022)", () => {
  assert.throws(() => parseConfig(withKeys({ pubkey: "nope" })), /pubkey/);
  assert.throws(() => parseConfig(withKeys({ ownerPubkey: "nope" })), /ownerPubkey/);
});

// FIX-116 follow-on, measured on a real community (2026-08-26): every member
// with a working picture — a human owner, a human member, and another node's
// bot — hosts it in the relay's own Blossom media store. So the refusal for a
// file path names the command that puts it there, rather than leaving someone
// to discover that an external URL may or may not be fetched by a client.
test("an agent avatar must be a URL, and the refusal says how to get one", () => {
  const bad = () =>
    parseConfig({
      relayUrl: "ws://localhost:3000",
      node: { pubkey: "9".repeat(64) },
      rooms: [{ channel: "c", agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64), avatar: "C:/pics/spike.png" }] }],
    });
  assert.throws(bad, /buzz upload file/);
  assert.throws(bad, /not a file path/i);
});

test("an agent avatar that IS a URL is kept", () => {
  const c = parseConfig({
    relayUrl: "ws://localhost:3000",
    node: { pubkey: "9".repeat(64) },
    rooms: [{ channel: "c", agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64), avatar: "https://relay.example/media/abc.png" }] }],
  });
  assert.equal(c.rooms[0].agents[0].avatar, "https://relay.example/media/abc.png");
});

test("no avatar is null, not an empty string", () => {
  const c = parseConfig({
    relayUrl: "ws://localhost:3000",
    node: { pubkey: "9".repeat(64) },
    rooms: [{ channel: "c", agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) }] }],
  });
  assert.equal(c.rooms[0].agents[0].avatar, null);
});
