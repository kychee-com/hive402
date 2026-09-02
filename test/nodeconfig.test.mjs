import { test } from "node:test";
import assert from "node:assert/strict";

import { parseConfig } from "../src/config/schema.mjs";

const PK = (c) => c.repeat(64);

const good = () => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: PK("9") },
  rooms: [
    {
      channel: "b86d8eda-5f05-496c-af45-ef4442ad5876",
      agents: [{ name: "spike", pubkey: PK("4"), ownerPubkey: PK("7") }],
    },
  ],
});

test("an agent carries its own identity as well as its owner's", () => {
  const cfg = parseConfig(good());
  assert.equal(cfg.rooms[0].agents[0].pubkey, PK("4"));
  assert.equal(cfg.rooms[0].agents[0].ownerPubkey, PK("7"));
});

test("the node has its own identity, separate from any agent", () => {
  // The node publishes wakes and answers /audit under its own key, so it must
  // be a distinct identity — not one of its agents, and not the owner.
  assert.equal(parseConfig(good()).node.pubkey, PK("9"));
});

test("a config with no node identity is refused", () => {
  const raw = good();
  delete raw.node;
  assert.throws(() => parseConfig(raw), /node/i);
});

test("the node identity may not double as one of its own agents", () => {
  const raw = good();
  raw.node.pubkey = PK("4");
  assert.throws(() => parseConfig(raw), /node identity|distinct|same/i);
});

// AC-32 / repo policy: credentials live in the OS credential store, never in a
// plaintext file. The config names WHERE a key comes from; it never holds one.
test("a private key written into the config file is refused outright", () => {
  const raw = good();
  raw.node.privateKey = PK("1");
  assert.throws(() => parseConfig(raw), /private key|keychain|plaintext/i);
});

test("a key reference names the keychain or an env var, never a literal", () => {
  const raw = good();
  raw.node.privateKeyRef = "env:HIVE402_NODE_KEY";
  assert.equal(parseConfig(raw).node.privateKeyRef, "env:HIVE402_NODE_KEY");

  // A key pasted where the REFERENCE goes is the obvious slip, and the refusal
  // must not repeat it: this message travels to terminal scrollback, CI logs and
  // pasted bug reports (DD-30, the F-014 class).
  raw.node.privateKeyRef = PK("1");
  assert.throws(() => parseConfig(raw), /keychain|env:|private KEY/i);
  assert.throws(
    () => parseConfig(raw),
    (err) => !err.message.includes(PK("1")),
    "the refusal must not echo the pasted key back",
  );
});

test("the key reference defaults to the OS keychain", () => {
  assert.equal(parseConfig(good()).node.privateKeyRef, "keychain");
});

// AC-26 / TR-002: the cap must be drivable in a test window. Cycle 1 could not
// exercise it at all — 20 real turns inside an hour was impractical.
test("the turn cap is configurable, and defaults to the spec's 20 per hour", () => {
  assert.equal(parseConfig(good()).turnCap.limit, 20);
  assert.equal(parseConfig(good()).turnCap.windowMs, 60 * 60 * 1000);

  const raw = good();
  raw.turnCap = { limit: 3, windowMs: 60000 };
  const cfg = parseConfig(raw);
  assert.equal(cfg.turnCap.limit, 3);
  assert.equal(cfg.turnCap.windowMs, 60000);
});

test("a nonsensical turn cap is refused rather than silently disabling the fuse", () => {
  for (const turnCap of [{ limit: 0 }, { limit: -1 }, { limit: "lots" }, { windowMs: 0 }]) {
    assert.throws(() => parseConfig({ ...good(), turnCap }), /turn cap|limit|window/i);
  }
});

test("two agents in one room may not share a pubkey", () => {
  const raw = good();
  raw.rooms[0].agents.push({ name: "spike2", pubkey: PK("4"), ownerPubkey: PK("8") });
  assert.throws(() => parseConfig(raw), /pubkey|identity/i);
});

test("the six owner-facing settings still survive, with their presets", () => {
  // AC-18 regression: adding node plumbing must not widen the settings surface.
  const a = parseConfig(good()).rooms[0].agents[0];
  assert.equal(a.replyMode, "well-mannered");
  assert.equal(a.crossOwnerAsks, "owner-approves");
  assert.equal(a.selfInitiated, "asks-owner");
  assert.equal(a.research, false);
  assert.equal(a.build, false);
});

test("a seventh setting is still refused", () => {
  const raw = good();
  raw.rooms[0].agents[0].mood = "cheerful";
  assert.throws(() => parseConfig(raw), /unknown setting/i);
});

test("an agent's key reference is allowed, but a pasted key is refused", () => {
  const withRef = good();
  withRef.rooms[0].agents[0].privateKeyRef = "env:SPIKE_KEY";
  assert.equal(parseConfig(withRef).rooms[0].agents[0].privateKeyRef, "env:SPIKE_KEY");

  const withKey = good();
  withKey.rooms[0].agents[0].privateKey = PK("1");
  assert.throws(() => parseConfig(withKey), /private key|keychain/i);

  const withBadRef = good();
  withBadRef.rooms[0].agents[0].privateKeyRef = PK("1");
  assert.throws(() => parseConfig(withBadRef), /privateKeyRef|keychain|private KEY/i);
  assert.throws(
    () => parseConfig(withBadRef),
    (err) => !err.message.includes(PK("1")),
    "the refusal must not echo the pasted key back",
  );

  // This assertion used to say the OPPOSITE — "a non-key ref is not a secret,
  // so that one IS echoed" — and that is precisely what F-016 was: whether the
  // value came back out depended on a detector recognising it, so a key one
  // character short of 64 was printed verbatim. Fix cycle 9 inverts the default
  // (DD-31): nothing is echoed, and the message carries kind and length instead.
  const withJunkRef = good();
  withJunkRef.rooms[0].agents[0].privateKeyRef = "file:/etc/keys";
  assert.throws(() => parseConfig(withJunkRef), (err) => !err.message.includes("file:/etc/keys"));
  assert.throws(() => parseConfig(withJunkRef), /14-character value/);
  // Still a diagnostic: both legal forms are named, so the operator can act.
  assert.throws(() => parseConfig(withJunkRef), /keychain/);
  assert.throws(() => parseConfig(withJunkRef), /env:VAR_NAME/);
});

test("tool paths are carried through for the launcher", () => {
  const raw = good();
  raw.tools = { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter\\index.js" };
  assert.equal(parseConfig(raw).tools.adapter, "C:\\adapter\\index.js");
});
