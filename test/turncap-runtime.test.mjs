// F-011 (cycle 3, P1) — AC-26's cap holds for the owner too.
//
// Cycle 2 disclosed this gap and called it unfixable from here: "the cap cannot
// recall a turn already delivered directly to an agent, because buzz-acp always
// admits the owner… A hard cap on owner traffic would have to come from the
// harness." Cycle 3 confirmed it exactly — notice always fires, non-owner
// traffic genuinely pauses, owner traffic sails past.
//
// The disclosure was true of the NODE and wrong about the product. The node
// owns the agent's runtime, and the runtime sees every turn, including the ones
// buzz-acp hands the owner directly. Counting where the turns actually arrive
// makes the pause a property of the runtime rather than a request anyone can
// route around (DD-23).
//
// Measured on this stack before building it: a UserPromptSubmit hook returning
// `decision: "block"` stops the turn, spends no model turn, and the agent
// answers the next message normally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  countTurn,
  drainPauseRecords,
  readPauseRecords,
  remainingTurns,
  runTurnGate,
} from "../src/runtime/turngate.mjs";

const now = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const PROMPT = `[Buzz event: @mention]
Event ID: ${"a".repeat(64)}
Kind: 9
From: npub1x (hex: ${"d".repeat(64)})
Content: @spike hello`;

async function withState(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-cap-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const turn = (dir, promptId, at, cap = 2) =>
  runTurnGate({
    stateDir: dir,
    agent: "spike",
    input: { prompt: PROMPT, prompt_id: promptId, session_id: "s1" },
    turnCap: { limit: cap, windowMs: HOUR },
    now: at,
  });

test("the ledger counts every turn, whoever sent it", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);
    assert.equal(remainingTurns({ stateDir: dir, agent: "spike", limit: 2, windowMs: HOUR, now: now + 2000 }), 0);
  });
});

test("F-011: the turn past the cap is BLOCKED at the prompt boundary", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);

    const third = await turn(dir, "p3", now + 2000);
    assert.equal(third.decision, "block", "an owner-direct turn must be stopped like any other");
    assert.equal(third.output.decision, "block");
    assert.match(third.output.reason, /turn/i);
  });
});

test("F-011: a blocked turn does not consume budget, so the pause cannot deepen itself", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);
    await turn(dir, "p3", now + 2000); // blocked
    await turn(dir, "p4", now + 3000); // blocked

    // Two real turns were spent, not four. As the window rolls, the budget
    // returns on schedule rather than being pushed out by refusals.
    assert.equal(remainingTurns({ stateDir: dir, agent: "spike", limit: 2, windowMs: HOUR, now: now + 4000 }), 0);
    // At now+HOUR+500 the cutoff is now+500: the turn at `now` has aged out and
    // the one at now+1000 has not, so exactly one turn comes back.
    assert.equal(
      remainingTurns({ stateDir: dir, agent: "spike", limit: 2, windowMs: HOUR, now: now + HOUR + 500 }),
      1,
      "the first turn has aged out of the window",
    );
  });
});

test("the window rolls, and a turn beyond it stops counting", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);
    const later = await turn(dir, "p3", now + HOUR + 2000);
    assert.equal(later.decision, "allow", "the window has rolled forward");
  });
});

test("a blocked turn is recorded so the node can announce the pause", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);
    await turn(dir, "p3", now + 2000);

    const paused = countTurn({ stateDir: dir, agent: "spike", limit: 2, windowMs: HOUR, now: now + 2500 });
    assert.equal(paused.allowed, false);
    assert.equal(paused.remaining, 0);
  });
});

test("with no cap configured the hook counts but never blocks", async () => {
  await withState(async (dir) => {
    for (let i = 0; i < 25; i += 1) {
      const result = await runTurnGate({
        stateDir: dir,
        agent: "spike",
        input: { prompt: PROMPT, prompt_id: `p${i}`, session_id: "s1" },
        now: now + i,
      });
      assert.equal(result.decision, "allow");
    }
  });
});

test("an unattributable turn is still counted — it is still a model turn", async () => {
  await withState(async (dir) => {
    await runTurnGate({
      stateDir: dir, agent: "spike", now,
      input: { prompt: "no header at all", prompt_id: "p1", session_id: "s1" },
      turnCap: { limit: 2, windowMs: HOUR },
    });
    assert.equal(remainingTurns({ stateDir: dir, agent: "spike", limit: 2, windowMs: HOUR, now: now + 10 }), 1);
  });
});

test("each agent has its own budget", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);
    assert.equal(remainingTurns({ stateDir: dir, agent: "spike2", limit: 2, windowMs: HOUR, now: now + 2000 }), 2);
  });
});

// ── The pause is announced by whoever actually blocked it (FIX-31b) ────────
//
// FOUND BY RUNNING IT (2026-08-16), in the scratch room built to test F-011.
// The node kept its own cap check on the dispatch path while the runtime had
// already become the counter. So the runtime counted turn 2 and let it run,
// and the node — polling a moment later — read "2 of 2 used" and announced a
// pause for the very turn that was about to be answered.
//
// Cosmetically that is a notice contradicted four seconds later by a reply. The
// real damage is on the other traffic class: for a NON-owner the node also
// suppresses the wake it would otherwise publish, so a message the runtime
// would have allowed is silently never delivered.
//
// One decision point. The runtime blocks; the node reports what the runtime
// blocked, and reports it once.

test("a blocked turn leaves a record for the node to announce", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);
    await turn(dir, "p3", now + 2000);

    const paused = readPauseRecords({ stateDir: dir, agent: "spike" });
    assert.equal(paused.length, 1);
    assert.equal(paused[0].agent, "spike");
    assert.equal(paused[0].limit, 2);
  });
});

test("an allowed turn leaves no pause record", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    assert.equal(readPauseRecords({ stateDir: dir, agent: "spike" }).length, 0);
  });
});

test("draining pause records consumes them, so the room is told once", async () => {
  await withState(async (dir) => {
    await turn(dir, "p1", now);
    await turn(dir, "p2", now + 1000);
    await turn(dir, "p3", now + 2000);
    await turn(dir, "p4", now + 3000);

    assert.equal(drainPauseRecords({ stateDir: dir, agent: "spike" }).length, 2);
    assert.equal(drainPauseRecords({ stateDir: dir, agent: "spike" }).length, 0);
  });
});
