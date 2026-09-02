import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnCap } from "../src/safety/turncap.mjs";

// A controllable clock so the rolling window is tested without sleeping.
function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}
const HOUR = 60 * 60 * 1000;

test("allows turns up to the cap", () => {
  const c = clock();
  const cap = new TurnCap({ limit: 3, now: c.now });
  assert.equal(cap.tryConsume("blitz").allowed, true);
  assert.equal(cap.tryConsume("blitz").allowed, true);
  assert.equal(cap.tryConsume("blitz").allowed, true);
});

test("blocks the turn that exceeds the cap", () => {
  const c = clock();
  const cap = new TurnCap({ limit: 2, now: c.now });
  cap.tryConsume("blitz");
  cap.tryConsume("blitz");
  const third = cap.tryConsume("blitz");
  assert.equal(third.allowed, false);
  assert.match(third.notice, /pause|cap|limit/i);
});

test("the cap is per agent, not global", () => {
  const c = clock();
  const cap = new TurnCap({ limit: 1, now: c.now });
  assert.equal(cap.tryConsume("blitz").allowed, true);
  assert.equal(cap.tryConsume("bzik").allowed, true, "bzik has its own budget");
  assert.equal(cap.tryConsume("blitz").allowed, false);
});

test("the window rolls: turns older than an hour stop counting", () => {
  const c = clock();
  const cap = new TurnCap({ limit: 2, now: c.now });
  cap.tryConsume("blitz");
  cap.tryConsume("blitz");
  assert.equal(cap.tryConsume("blitz").allowed, false);
  c.advance(HOUR + 1000);
  assert.equal(cap.tryConsume("blitz").allowed, true, "budget refreshed after the window");
});

test("a partially aged window frees exactly the expired turns", () => {
  const c = clock();
  const cap = new TurnCap({ limit: 2, now: c.now });
  cap.tryConsume("blitz");
  c.advance(HOUR / 2);
  cap.tryConsume("blitz");
  assert.equal(cap.tryConsume("blitz").allowed, false);
  c.advance(HOUR / 2 + 1000); // first turn expires, second has not
  assert.equal(cap.tryConsume("blitz").allowed, true);
  assert.equal(cap.tryConsume("blitz").allowed, false);
});

test("the pause notice is emitted once per window, not on every blocked turn", () => {
  const c = clock();
  const cap = new TurnCap({ limit: 1, now: c.now });
  cap.tryConsume("blitz");
  const first = cap.tryConsume("blitz");
  const second = cap.tryConsume("blitz");
  assert.ok(first.notice, "first block announces");
  assert.equal(second.notice, null, "subsequent blocks stay quiet");
});

test("remaining() reports the live budget", () => {
  const c = clock();
  const cap = new TurnCap({ limit: 20, now: c.now });
  assert.equal(cap.remaining("blitz"), 20);
  cap.tryConsume("blitz");
  assert.equal(cap.remaining("blitz"), 19);
});

test("defaults to the spec's 20 turns per rolling hour", () => {
  const cap = new TurnCap();
  assert.equal(cap.remaining("anyone"), 20);
});

// ── The ledger is the authority (DD-23, fix cycle 3) ──────────────────────
//
// The runtime counts turns now, because it is the only place that sees the ones
// buzz-acp hands an agent's owner directly (F-011). The node still needs to
// know the number — to post the pause notice, to answer `/turns`, and to skip
// publishing a wake nobody will run — but it must READ that number rather than
// keep a second one, or owner traffic would be counted once and node traffic
// twice.

test("with a ledger, remaining() reflects the runtime's count, not the node's", () => {
  let used = 0;
  const cap = new TurnCap({ limit: 5, ledger: { used: () => used } });
  assert.equal(cap.remaining("spike"), 5);
  used = 3;
  assert.equal(cap.remaining("spike"), 2);
});

test("with a ledger, the node checks the cap but does not spend it", () => {
  const cap = new TurnCap({ limit: 2, ledger: { used: () => 0 } });
  cap.tryConsume("spike");
  cap.tryConsume("spike");
  cap.tryConsume("spike");
  assert.equal(cap.remaining("spike"), 2, "the runtime records turns; the node must not");
});

test("with a ledger at the limit, the node still announces the pause exactly once", () => {
  const cap = new TurnCap({ limit: 2, ledger: { used: () => 2 } });
  const first = cap.tryConsume("spike");
  assert.equal(first.allowed, false);
  assert.match(first.notice, /Pausing/);
  assert.equal(cap.tryConsume("spike").notice, null, "no spamming the room");
});
