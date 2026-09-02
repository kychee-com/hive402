#!/usr/bin/env node
// The turn gate — hive402's answer to F-009 and F-011.
//
// This runs INSIDE the agent's model runtime, as a `UserPromptSubmit` hook
// declared in the per-agent settings the node writes. It fires once at the
// start of every turn, before the model sees the prompt, and it can refuse the
// turn outright.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Cycle 2 gave capability to the TURN instead of to the process, which held.
// But the node still could not answer one question: *which message caused which
// turn?* It never can on its own — buzz-acp delivers an owner's message
// straight to their agent, so those turns never pass through the node at all.
// So the node kept a single "last trigger" slot per agent and guessed.
//
// Cycle 3 broke the guess. Two messages 40ms apart, and the node attributed the
// owner's own blocked fetch to the non-owner who happened to message second:
// the approval prompt named the owner's target, and the approval released the
// non-owner's unrelated fetch (F-009). The same blind spot meant those turns
// could not be counted either, so the turn cap did not apply to them (F-011).
//
// The runtime, however, knows. Measured on this exact stack (buzz-acp ->
// claude-agent-acp -> claude-agent-sdk 0.3.220, project settings,
// permission_mode=bypassPermissions): this hook fires on every turn, carries
// the same `prompt_id` the tool gate sees, and its prompt contains the
// harness's own header for the event that woke the agent. So the runtime
// reports its own trigger, and the node stops guessing.
//
// ── What it does NOT read ──────────────────────────────────────────────────
//
// Only the event id. Not the author, not the content, not the requester's
// name. The `From:` line renders the author's chosen display name, and a
// display name may contain newlines — which makes every byte after `From:`
// user-writable. `Event ID:` is the block's first field, so it is the one value
// that sits ahead of anything a hostile message can inject. The author is
// something the node already knows, signature-verified, from the relay; taking
// it from the prompt instead would be redundant AND forgeable, which is the
// worst of both.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const HEX64 = "[0-9a-f]{64}";

// The harness's own header block, whose first field is the event id:
//
//   [Buzz event: @mention]
//   Event ID: <64 hex>
//
// `Event ID:` must sit on the very next line. The bytes before this block come
// from the [Context] header, whose only user-influenced field is the channel
// name; requiring the exact two-line shape means a forged marker smuggled
// through a name would have to reproduce it precisely, and the node's own
// per-event record is the cross-check that decides even then.
const TRIGGER_RE = new RegExp(String.raw`\[Buzz event:[^\]\n]*\]\r?\nEvent ID: (${HEX64})\b`);

export function parseTrigger(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  if (!text) return null;
  const match = TRIGGER_RE.exec(text);
  if (!match) return null;
  return { eventId: match[1] };
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function turnRecordPath({ stateDir, agent, promptId }) {
  return path.join(stateDir, "turns", safeName(agent), `${safeName(promptId)}.json`);
}

function writeAtomic(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  // The tool gate reads this from the same process moments later, and a
  // half-written file would deny a turn that was entitled to run.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return record;
}

export function writeTurnRecord({ stateDir, agent, promptId, sessionId, eventId, now = Date.now() }) {
  return writeAtomic(turnRecordPath({ stateDir, agent, promptId }), {
    kind: "turn",
    agent,
    promptId,
    sessionId: sessionId ?? null,
    eventId,
    at: now,
  });
}

export function readTurnRecord({ stateDir, agent, promptId }) {
  if (!promptId) return null;
  const file = turnRecordPath({ stateDir, agent, promptId });
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (!record || record.kind !== "turn" || typeof record.eventId !== "string") return null;
    return record;
  } catch {
    return null;
  }
}

// ── AC-26's fuse, at the boundary every turn crosses (DD-23) ───────────────
//
// The cap used to be spent by the node when it dispatched a wake. That works
// for traffic the node routes and does nothing at all for the rest: buzz-acp
// admits an agent's owner regardless of the allowlist, so those turns never
// passed the node's counter. Cycle 2 disclosed the gap and called it the
// harness's problem; cycle 3 confirmed it (F-011). It is not the harness's
// problem — it is a question of counting in the right place. Here, every turn
// is visible, so here is where the fuse belongs.

export function turnLedgerPath({ stateDir, agent }) {
  return path.join(stateDir, "turns", safeName(agent), "ledger.json");
}

function readLedger({ stateDir, agent }) {
  const file = turnLedgerPath({ stateDir, agent });
  if (!existsSync(file)) return [];
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(record?.turns) ? record.turns.filter((t) => typeof t === "number") : [];
  } catch {
    // An unreadable ledger must not hand out free turns. Treating it as full
    // would be the paranoid answer, but it would also wedge the agent forever
    // on a single bad write; the node re-derives from its own record too.
    return [];
  }
}

const liveTurns = (turns, windowMs, now) => turns.filter((t) => t > now - windowMs);

export function remainingTurns({ stateDir, agent, limit, windowMs = 60 * 60 * 1000, now = Date.now() }) {
  return Math.max(0, limit - liveTurns(readLedger({ stateDir, agent }), windowMs, now).length);
}

// Spend one turn if the budget allows. A refused turn is NOT recorded: it costs
// no model call, and counting it would let a paused agent push its own recovery
// further away every time somebody spoke to it.
export function countTurn({ stateDir, agent, limit, windowMs = 60 * 60 * 1000, now = Date.now() }) {
  const live = liveTurns(readLedger({ stateDir, agent }), windowMs, now);
  if (live.length >= limit) {
    return { allowed: false, remaining: 0, used: live.length };
  }
  const turns = [...live, now];
  writeAtomic(turnLedgerPath({ stateDir, agent }), { kind: "turns", agent, turns });
  return { allowed: true, remaining: Math.max(0, limit - turns.length), used: turns.length };
}

// A refused turn, left for the node to tell the room about.
//
// The runtime is the only party that can block a turn, so it must also be the
// only party that says one was blocked. FOUND BY RUNNING IT (2026-08-16): while
// the node still made its own cap decision on the dispatch path, it read the
// ledger a moment after the runtime had counted a turn, concluded the agent was
// at its limit, and announced a pause for the turn that was about to be
// answered — and for a non-owner it would also have withheld the wake, silently
// dropping a message the runtime would have allowed.
function pausePath({ stateDir, agent }) {
  return path.join(stateDir, "paused", safeName(agent));
}

function writePauseRecord({ stateDir, agent, limit, windowMs, now }) {
  const dir = pausePath({ stateDir, agent });
  mkdirSync(dir, { recursive: true });
  const record = { kind: "paused", agent, limit, windowMs, at: now };
  writeFileSync(
    path.join(dir, `${now}-${Math.random().toString(36).slice(2, 8)}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return record;
}

export function readPauseRecords({ stateDir, agent }) {
  const dir = pausePath({ stateDir, agent });
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
    } catch {
      /* unreadable — the sweep below removes it either way */
    }
  }
  return records;
}

export function drainPauseRecords({ stateDir, agent }) {
  const dir = pausePath({ stateDir, agent });
  const records = readPauseRecords({ stateDir, agent });
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      try {
        rmSync(path.join(dir, name), { force: true });
      } catch {
        /* already gone */
      }
    }
  }
  return records;
}

// The gate, end to end.
//
// Note the asymmetry with the tool gate, and it is deliberate: the tool gate
// fails CLOSED, this one fails OPEN. A tool call it cannot evaluate must not
// run. A turn it cannot attribute must still start — because the thing that
// stops an unattributed turn from acting is the tool gate downstream (no turn
// record means no authority means no action), while a turn killed here is an
// agent that never speaks. Cycle 3's F-010 is the standing reminder that a
// silent agent is a worse failure than a refused one.
export async function runTurnGate({ stateDir, agent, input, turnCap = null, now = Date.now() }) {
  const allow = { decision: "allow", output: null };
  try {
    if (!input || typeof input !== "object") return allow;

    // AC-26 first: a turn that will not run needs no authority record, and
    // must not be counted twice by recording it here and refusing it below.
    if (turnCap?.limit > 0) {
      const spent = countTurn({
        stateDir,
        agent,
        limit: turnCap.limit,
        windowMs: turnCap.windowMs ?? 60 * 60 * 1000,
        now,
      });
      if (!spent.allowed) {
        const windowMs = turnCap.windowMs ?? 60 * 60 * 1000;
        const minutes = Math.ceil(windowMs / 60000);
        try {
          writePauseRecord({ stateDir, agent, limit: turnCap.limit, windowMs, now });
        } catch {
          // The room misses a notice; the turn is still blocked, which is the
          // half that matters.
        }
        return {
          decision: "block",
          output: {
            decision: "block",
            reason:
              `hive402: ${agent} has used its limit of ${turnCap.limit} model turns in the last ` +
              `${minutes} minutes and is paused until that window rolls forward. This turn was not ` +
              `run. Do not retry it.`,
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              suppressOriginalPrompt: true,
            },
          },
        };
      }
    }

    const trigger = parseTrigger(input.prompt);
    if (!trigger) return allow;

    writeTurnRecord({
      stateDir,
      agent,
      promptId: input.prompt_id ?? null,
      sessionId: input.session_id ?? null,
      eventId: trigger.eventId,
      now,
    });
    return allow;
  } catch {
    // Whatever went wrong, it is not worth a mute agent.
    return allow;
  }
}

// --- hook entry point -------------------------------------------------------
//
// Invoked as: node turngate.mjs --agent <name> --state <stateDir>
// stdin: the runtime's UserPromptSubmit payload. stdout: nothing, or a block
// decision.

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isEntryPoint) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    payload = null;
  }
  const limit = Number(argOf("turn-cap") ?? 0);
  const windowMs = Number(argOf("turn-window") ?? 0) || 60 * 60 * 1000;
  let result = { decision: "allow", output: null };
  try {
    result = await runTurnGate({
      stateDir: argOf("state") ?? process.env.HIVE402_STATE_DIR ?? ".hive402",
      agent: argOf("agent") ?? process.env.HIVE402_AGENT ?? "unknown",
      input: payload,
      turnCap: limit > 0 ? { limit, windowMs } : null,
    });
  } catch {
    /* fail open — see runTurnGate */
  }
  if (result.output) process.stdout.write(JSON.stringify(result.output));
  process.exit(0);
}
