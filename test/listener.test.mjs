import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMentions, decideWake } from "../src/listener/mentions.mjs";

const agents = [
  { name: "blitz", pubkey: "a".repeat(64), ownerPubkey: "0".repeat(64) },
  { name: "bzik", pubkey: "b".repeat(64), ownerPubkey: "0".repeat(64) },
];

const HUMAN = "d".repeat(64);

test("resolves an @name to the agent pubkey", () => {
  assert.deepEqual(resolveMentions("@blitz can you help?", agents), ["a".repeat(64)]);
});

test("matching is case-insensitive", () => {
  assert.deepEqual(resolveMentions("@Blitz hi", agents), ["a".repeat(64)]);
});

test("resolves multiple distinct agents once each", () => {
  const got = resolveMentions("@blitz and @bzik and @blitz again", agents);
  assert.deepEqual(got.sort(), ["a".repeat(64), "b".repeat(64)].sort());
});

test("an unknown @name resolves to nothing", () => {
  assert.deepEqual(resolveMentions("@nobody hello", agents), []);
});

test("a bare name without @ is not a mention", () => {
  assert.deepEqual(resolveMentions("blitz should look at this", agents), []);
});

test("does not match a name embedded in a longer word", () => {
  assert.deepEqual(resolveMentions("@blitzkrieg is a word", agents), []);
});

test("punctuation right after the name still resolves", () => {
  assert.deepEqual(resolveMentions("@blitz, please look", agents), ["a".repeat(64)]);
});

// --- wake decisions -------------------------------------------------------

test("a human mention with no p-tag needs a wake (the Desktop gap)", () => {
  const d = decideWake({
    event: { kind: 9, pubkey: HUMAN, content: "@blitz hi", tags: [] },
    agents,
  });
  assert.deepEqual(d.wake, ["a".repeat(64)]);
});

test("an already p-tagged mention needs no wake (the relay delivered it)", () => {
  const d = decideWake({
    event: { kind: 9, pubkey: HUMAN, content: "@blitz hi", tags: [["p", "a".repeat(64)]] },
    agents,
  });
  assert.deepEqual(d.wake, []);
});

test("an unaddressed message wakes nobody (addressed-only, step 1)", () => {
  const d = decideWake({
    event: { kind: 9, pubkey: HUMAN, content: "just chatting", tags: [] },
    agents,
  });
  assert.deepEqual(d.wake, []);
});

test("an agent's own message never wakes agents (loop guard, AC-25)", () => {
  const d = decideWake({
    event: { kind: 9, pubkey: "a".repeat(64), content: "@bzik take over", tags: [] },
    agents,
  });
  assert.deepEqual(d.wake, []);
  assert.match(d.reason, /agent-authored/i);
});

test("non-message kinds are ignored", () => {
  const d = decideWake({
    event: { kind: 7, pubkey: HUMAN, content: "@blitz", tags: [] },
    agents,
  });
  assert.deepEqual(d.wake, []);
});

test("an agent is never woken by a mention of itself from itself", () => {
  const d = decideWake({
    event: { kind: 9, pubkey: "a".repeat(64), content: "@blitz note to self", tags: [] },
    agents,
  });
  assert.deepEqual(d.wake, []);
});
