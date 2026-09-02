import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { assertOwnEventKind, HIVE402_WRITABLE_KINDS } from "../src/safety/buzzgovernance.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const HUMAN = "d".repeat(64);

// AC-24: an agent may address another agent, the addressed agent may reply
// once, and then a human must speak before those two go again.
test("agent A may address agent B", () => {
  const g = new LoopGuard();
  assert.equal(g.allow({ from: A, to: B }).allowed, true);
});

test("agent B may reply once to agent A", () => {
  const g = new LoopGuard();
  g.allow({ from: A, to: B });
  assert.equal(g.allow({ from: B, to: A }).allowed, true);
});

test("a third agent-to-agent message without a human is blocked", () => {
  const g = new LoopGuard();
  g.allow({ from: A, to: B });
  g.allow({ from: B, to: A });
  const third = g.allow({ from: A, to: B });
  assert.equal(third.allowed, false);
  assert.match(third.reason, /human/i);
});

test("a human message resets the exchange", () => {
  const g = new LoopGuard();
  g.allow({ from: A, to: B });
  g.allow({ from: B, to: A });
  g.humanSpoke(HUMAN);
  assert.equal(g.allow({ from: A, to: B }).allowed, true);
});

test("the guard is per agent pair, not global", () => {
  const C = "c".repeat(64);
  const g = new LoopGuard();
  g.allow({ from: A, to: B });
  g.allow({ from: B, to: A });
  assert.equal(g.allow({ from: A, to: C }).allowed, true, "a different pair has its own budget");
});

test("direction does not create a fresh budget for the same pair", () => {
  const g = new LoopGuard();
  g.allow({ from: A, to: B });
  g.allow({ from: B, to: A });
  assert.equal(g.allow({ from: B, to: A }).allowed, false);
});

// AC-28: hive402 adds behavior only where Buzz provides none — it must never
// write Buzz-governed channel settings.
test("hive402's own event kinds are writable", () => {
  for (const kind of HIVE402_WRITABLE_KINDS) {
    assert.doesNotThrow(() => assertOwnEventKind(kind));
  }
});

test("writing a Buzz-governed channel-settings kind is refused", () => {
  // kind 39000-39002 are Buzz's channel metadata/roster discovery events.
  assert.throws(() => assertOwnEventKind(39000), /buzz-governed|not ours/i);
  assert.throws(() => assertOwnEventKind(39002), /buzz-governed|not ours/i);
});

test("an unknown kind is refused rather than assumed safe", () => {
  assert.throws(() => assertOwnEventKind(31337), /unknown|not ours/i);
});

// FIX-121: kind 10100 is Buzz's, not ours (AC-28, reversing DD-5's assumption).
//
// The spike measured it at buzz `origin/main` 29f2054c. It is REPLACEABLE per
// pubkey; the only writer in the Buzz CLI is `buzz channels set-add-policy`,
// publishing `{"channel_add_policy": …}` with no merge; and the relay's own
// side-effect handler errors "kind:10100 missing channel_add_policy field" on a
// record without one. So a hive402 write destroys Buzz's policy record AND is
// rejected as a policy update.
//
// It would not even buy what DD-5 wanted. Desktop drops legacy 10100 directory
// entries lacking a verified NIP-OA owner on any RELEASE build
// (`retain_agents_allowed_by_build`, gated on
// `BUZZ_DESKTOP_BUILD_AGENT_ACCESS_OWNER_ONLY`, which release packaging sets).
test("kind 10100 is refused — it is Buzz's channel-add policy, not our directory", () => {
  assert.throws(() => assertOwnEventKind(10100), /buzz-governed|not ours/i);
  assert.ok(
    !HIVE402_WRITABLE_KINDS.includes(10100),
    "10100 must not be back on the writable list — DD-5's assumption was measured and is wrong",
  );
});

test("kind 0 IS ours — it is what makes an @name resolve", () => {
  // The record DD-5 was looking for. `publisher.mjs` publishes it under the
  // agent's own identity, and it is what a mention resolves against.
  assert.doesNotThrow(() => assertOwnEventKind(0));
});
