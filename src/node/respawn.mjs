// Bringing an agent back (fix cycle 10, DD-34).
//
// AC-41/AC-42 make the node set `--exit-after-inactivity 3600` on every agent,
// so an agent nobody has spoken to for an hour exits. That is deliberate and
// stays: it is HOW an agent is cheap on its owner's machine. What was missing is
// the other half — nothing started it again. A room with no traffic for an hour
// went permanently deaf while the node stayed alive and kept answering `/help`,
// which is why every surface a human would check reported "up".
//
// This module holds the three facts the node needs to close that gap, kept out
// of the supervisor because each one is worth testing on its own:
//
//   1. IS IT RUNNING — and the answer is sourced differently depending on what
//      the node actually holds. For a child THIS process spawned, the handle
//      reports the exit itself; there is no number to be wrong about. For an
//      ADOPTED agent (a pid `up` reclaimed from a previous node's file) there is
//      only a number, which is exactly the situation DD-25 is about, so it goes
//      through the same `classifyRecorded` probe `up`, `down`, `status` and
//      `doctor` use.
//   2. WHY DID IT STOP — read out of the harness's own log rather than guessed.
//      "It exited on the idle policy" and "it died and we do not know why" are
//      different sentences to put in front of an operator, and only one of them
//      is supported by evidence.
//   3. IS IT READY YET — a relaunched harness is not listening the instant the
//      process exists. Publishing the wake before it has subscribed to the room
//      loses the message silently, which is the same failure wearing a new hat.

import { existsSync, readFileSync } from "node:fs";

import { classifyRecorded } from "./liveness.mjs";

// How long the node will wait for a relaunched harness before giving up and
// publishing the wake anyway. Measured cold start on the dev rig is ~2.7s from
// `buzz-acp starting:` to `agent_pool_ready`, so this is a ceiling for a bad
// day, not a budget anyone should reach.
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
// Once the harness is subscribed to the channel it will RECEIVE the wake even
// if its pool is still starting, because the harness queues. So a subscribed
// harness is "ready enough" after a grace rather than after the ceiling — the
// grace only exists for a pool that never announces itself.
//
// Ten seconds, not five: measured cold starts on the dev rig put
// `agent_pool_ready` 2.7s and 5.5s after `subscribed to channel`, and a 5s
// grace returned half a second BEFORE the stronger signal on the 5.5s run. The
// wake is not lost either way (the harness queues), but there is no reason to
// answer a question on the weaker evidence when the difference is half a second
// inside a cold turn that costs seventy.
export const DEFAULT_READY_GRACE_MS = 10_000;
export const DEFAULT_READY_POLL_MS = 200;

// What an operator most needs to know about an agent that is not running: it is
// not a thing they have to go and fix.
export const RESPAWN_HINT = "it will respawn when it is next addressed";

const POOL_READY_RE = /agent_pool_ready/i;
const START_MARKER = "buzz-acp starting:";
const IDLE_EXIT_RE = /inactivity bound reached[^\n]*/i;

// ESC [ … m, written from a char code for the same reason doctor.mjs does it: a
// literal escape byte in source is invisible in every diff view, and the
// harness's log is full of them.
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_RE, "");
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- 1. is it running --------------------------------------------------------

// The state of one agent's process, from whatever the node actually holds for
// it. Returns `{ alive, state, detail }`, where `state` is the word `status` and
// `doctor` put in front of a human:
//
//   running       it is up
//   idle-exited   its process is gone; the node will bring it back on a wake
//   stale-record  that pid now belongs to somebody else (NOT our agent exiting)
//   stopped       this node killed it
//   not-launched  nothing was ever started for this agent
export function agentProcessState(child, { classify } = {}) {
  if (!child) {
    return { alive: false, state: "not-launched", detail: "no agent process has been launched yet" };
  }
  if (child.killed) {
    return { alive: false, state: "stopped", detail: `pid ${child.pid} was stopped by this node` };
  }

  // A pid without a handle is a claim (DD-25) — ask the OS who holds it.
  if (child.adopted) {
    const verdict = classify
      ? classify(child.pid)
      : { state: "gone", detail: `pid ${child.pid} could not be checked` };
    if (verdict.state === "ours" || verdict.state === "unconfirmed") {
      return { alive: true, state: "running", detail: verdict.detail };
    }
    // "Reused" is a different fact from "our agent exited", and flattening them
    // would tell an operator their agent will come back when in truth the node
    // is looking at somebody else's process.
    if (verdict.state === "reused") {
      return { alive: false, state: "stale-record", detail: verdict.detail };
    }
    return { alive: false, state: "idle-exited", detail: `${verdict.detail}; ${RESPAWN_HINT}` };
  }

  // A child this process spawned reports its own exit through the handle we
  // still hold. That is a stronger fact than any pid probe, and free.
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return {
      alive: false,
      state: "idle-exited",
      detail: `pid ${child.pid} exited (code ${child.exitCode}); ${RESPAWN_HINT}`,
    };
  }
  return { alive: true, state: "running", detail: `pid ${child.pid} is running` };
}

// The same three-way split, for the callers that start from a pid-file verdict
// instead of a child handle (`status`, `doctor`).
export function agentStateFromVerdict(verdict, { pid, logText = null } = {}) {
  if (verdict.state === "ours" || verdict.state === "unconfirmed") {
    return { alive: true, state: "running", detail: verdict.detail };
  }
  if (verdict.state === "reused") {
    return { alive: false, state: "stale-record", detail: verdict.detail };
  }
  return { alive: false, state: "idle-exited", detail: idleExitDetail({ pid, logText }) };
}

// --- 2. why did it stop ------------------------------------------------------

// What the harness itself said about the END of its most recent run.
//
// Scoped to the current run on purpose: the agent log is appended to across
// restarts, so an `inactivity bound reached` from three restarts ago would
// otherwise be reported as the reason this process is gone.
export function exitEvidence(logText) {
  const text = stripAnsi(logText);
  const lastStart = text.lastIndexOf(START_MARKER);
  const current = lastStart >= 0 ? text.slice(lastStart) : text;
  const match = current.match(IDLE_EXIT_RE);
  if (!match) {
    return { idle: false, detail: "the agent log does not record why the process stopped" };
  }
  return { idle: true, detail: match[0].trim() };
}

export function idleExitDetail({ pid, logText = null }) {
  const evidence = exitEvidence(logText);
  const because = evidence.idle
    ? `the harness exited it on the idle policy ("${evidence.detail}")`
    : `the process is gone and ${evidence.detail}`;
  return `pid ${pid} is not running: ${because}. ${capitalise(RESPAWN_HINT)}.`;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Read an agent's log the way `status` and `doctor` need it: best effort, never
// throwing, and bounded so a week-old log does not get pulled into memory.
export function readAgentLog(file, { maxBytes = 64 * 1024 } = {}) {
  if (!file || !existsSync(file)) return "";
  try {
    const buf = readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

// --- 3. is it ready yet ------------------------------------------------------

// There is no room notice here any more (DD-43, spec 0.5.0).
//
// `respawnNotice` used to live at this spot and posted "Waking <agent> up, give
// it about a minute." the instant the node decided to relaunch. AC-5 as amended
// removed it: Buzz's own clients already show a working indicator against the
// addressed agent, so the line told the waiting human what their client was
// telling them anyway, and told everyone ELSE in the room something they had
// not asked about. The respawn itself — the part that actually fixed FIX-74's
// deaf room — is untouched; only the announcement is gone.

function readSince(file, fromByte) {
  if (!file || !existsSync(file)) return "";
  try {
    const buf = readFileSync(file);
    return buf.length <= fromByte ? "" : buf.subarray(fromByte).toString("utf8");
  } catch {
    return "";
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait until a relaunched harness will actually receive the wake we are about
// to publish.
//
// `fromByte` is where this launch's output starts in the log file, because the
// file is opened for APPEND: reading the whole thing finds the previous run's
// `agent_pool_ready` and returns instantly, publishing the wake to a harness
// that is not listening yet.
//
// Never throws and never blocks forever. A caller that gets `ready: false`
// should publish the wake anyway and say what happened — an undelivered wake is
// the silence this fix exists to remove.
export async function waitForAgentReady({
  logFile,
  fromByte = 0,
  channel = null,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  graceMs = DEFAULT_READY_GRACE_MS,
  pollMs = DEFAULT_READY_POLL_MS,
  read = readSince,
  sleep = wait,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  const subscribed = new RegExp(`subscribed to channel\\s+${escapeRegExp(channel)}`, "i");
  let subscribedAt = null;

  for (;;) {
    const text = stripAnsi(read(logFile, fromByte));
    if (POOL_READY_RE.test(text)) {
      return { ready: true, detail: "the harness reported its agent pool ready" };
    }
    if (subscribedAt === null && subscribed.test(text)) subscribedAt = now();

    const at = now();
    if (subscribedAt !== null && at - subscribedAt >= graceMs) {
      return { ready: true, detail: "the harness is subscribed to the room; its pool is still starting" };
    }
    if (at >= deadline) {
      return {
        ready: false,
        detail:
          subscribedAt !== null
            ? "the harness subscribed to the room but never reported a ready pool"
            : `the harness did not report itself subscribed to the room within ${timeoutMs}ms`,
      };
    }
    await sleep(pollMs);
  }
}

// The probe the supervisor hands `agentProcessState` for an adopted pid. Kept
// here so the one place that decides "is this agent alive" also owns how that
// question reaches the OS.
export function agentClassifier({ recordedAt = null, identify, isAlive } = {}) {
  return (pid) =>
    classifyRecorded({
      pid,
      kind: "agent",
      recordedAt,
      ...(identify ? { identify } : {}),
      ...(isAlive ? { isAlive } : {}),
    });
}
