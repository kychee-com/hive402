// The checks `hive402 doctor` runs that need real logic (fix cycle 2).
//
// TR-004 asked for a product-native way to confirm the AC-41/AC-42 lifecycle
// policy, because the surface the Blue Team itself prescribed in cycle 1 — the
// harness's `buzz-acp starting:` line — turned out to omit exactly the three
// settings in question. It prints 21 fields, including ones sitting at their
// zero default (`heartbeat=0s`), and none of them is `lazy_pool`,
// `idle_pool_sleep` or `exit_after_inactivity` (`buzz-acp/src/config.rs`,
// `Config::summary()`).
//
// So this offers three independent surfaces, and deliberately none of them is
// "hive402 says so":
//
//   1. the LIVE PROCESS COMMAND LINE, because the node now passes the policy as
//      flags (DD-18). Anyone can read it with `Get-CimInstance Win32_Process`
//      or `ps`; no product cooperation required. This is the surface cycle 1
//      wrongly dismissed, made correct.
//   2. the HARNESS'S OWN WORDS in the agent log — `idle pool sleep bound
//      reached … idle_pool_sleep_seconds=900` is emitted by buzz-acp itself and
//      is only reachable when lazy pool is on and the sleep is non-zero.
//   3. the node's resolved policy table, which is the only one that is our
//      claim, and is reported as such.
//
// AC-40's pin is the same problem in miniature: `Get-Item .VersionInfo` returns
// nothing for these binaries, so "verified against the pinned build" was an
// assertion nobody could repeat. A content hash is repeatable.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import { lifetimePolicyReport } from "../launcher/env.mjs";
import { classifyRecorded, makeIdentifier } from "./liveness.mjs";
import { agentStateFromVerdict, readAgentLog } from "./respawn.mjs";

// Which agents `doctor` can meaningfully ask about right now (O-3, DD-25).
//
// With everything gone overnight, `doctor` printed a lifecycle-policy FAIL per
// agent, naming pids that no longer existed. The hint each FAIL carried ("run
// this while the node is up") was correct, which makes the shape of the bug
// clear: it had the right answer and reported it as two failures about ghosts
// instead of one fact about the node.
//
// A down node is NOT a doctor failure. `doctor` checks that the setup is
// correct, and "you have not started it" is not an incorrect setup — so this
// reports, and the exit code keeps meaning what it meant.
export function lifecycleSubjects({ record, identify, stateDir = null } = {}) {
  if (!record?.node) {
    return { nodeDown: true, detail: "no node has been started yet (no pid file)", agents: [], stale: [], idleExited: [] };
  }

  const recordedAt = record.startedAt ?? null;
  const pids = [record.node, ...(record.agents ?? []).map((a) => a.pid)].filter(Boolean);
  const lookup = identify ?? makeIdentifier(pids);

  const node = classifyRecorded({ pid: record.node, kind: "node", recordedAt, identify: lookup });
  if (node.state !== "ours" && node.state !== "unconfirmed") {
    return {
      nodeDown: true,
      // "gone" already reads as a whole sentence about that pid; "reused" says
      // something more specific. Prefixing both produces "pid N is not running
      // — pid N is not running", which is how a diagnosis loses authority.
      detail:
        node.state === "gone"
          ? `the node recorded as pid ${record.node} is no longer running`
          : node.detail,
      agents: [],
      stale: [],
      idleExited: [],
    };
  }

  // Three outcomes, not two (FIX-75). "Its process exited and the node will
  // bring it back when somebody addresses it" and "that number now belongs to a
  // stranger" are different situations for an operator, and reporting both as a
  // stale record is how the first one reads as damage.
  const agents = [];
  const stale = [];
  const idleExited = [];
  for (const a of record.agents ?? []) {
    const verdict = classifyRecorded({ pid: a.pid, kind: "agent", recordedAt, identify: lookup });
    const logText = verdict.state === "gone" ? readAgentLog(agentLogFile(stateDir, a.name)) : null;
    const view = agentStateFromVerdict(verdict, { pid: a.pid, logText });
    if (view.alive) agents.push({ name: a.name, pid: a.pid });
    else if (view.state === "idle-exited") idleExited.push({ name: a.name, pid: a.pid, detail: view.detail });
    else stale.push({ name: a.name, pid: a.pid, detail: view.detail });
  }
  return { nodeDown: false, detail: node.detail, agents, stale, idleExited };
}

function agentLogFile(stateDir, name) {
  return stateDir ? `${stateDir}/logs/${name}.log` : null;
}

// Is every AC-41/AC-42 policy actually on the live process's command line, with
// the value we intended? Presence alone is not enough — `--idle-pool-sleep 0`
// is the harness default wearing our flag's clothes.
export function lifecycleCheck({ commandLine }) {
  const policies = lifetimePolicyReport();
  if (!commandLine) {
    return {
      ok: false,
      detail:
        "could not read the agent process's command line — run this while the node is up " +
        "(the policy is still supplied by env, but it cannot be confirmed from outside)",
    };
  }

  const problems = [];
  const confirmed = [];
  for (const { flag, value, boolean: isBool } of policies) {
    if (isBool) {
      if (!new RegExp(`${flag}(\\s|$|=)`).test(commandLine)) problems.push(`${flag} missing`);
      else confirmed.push(flag);
      continue;
    }
    const match = commandLine.match(new RegExp(`${flag}[= ]+(\\S+)`));
    if (!match) problems.push(`${flag} missing`);
    else if (match[1] !== value) problems.push(`${flag} is ${match[1]}, expected ${value}`);
    else confirmed.push(`${flag} ${value}`);
  }

  return problems.length === 0
    ? { ok: true, detail: `on the live command line: ${confirmed.join(" ")}` }
    : { ok: false, detail: `lifecycle policy not confirmed on the live process: ${problems.join("; ")}` };
}

const IDLE_SLEEP_RE = /idle pool sleep bound reached[^\n]*idle_pool_sleep_seconds\D*(\d+)/i;
const STARTING_RE = /^(\S+)\s.*buzz-acp starting:/;
const POOL_READY_RE = /^(\S+)\s.*agent_pool_ready/;

// What the harness itself has said about its own lifecycle policy.
//
// This is the strongest evidence available, because it is not our claim: the
// line is buzz-acp's, in buzz-acp's own log, and it is only emitted when the
// policy it names is actually in force.
export function harnessLifecycleEvidence({ logText }) {
  // Strip the harness's colour codes FIRST. `idle_pool_sleep_seconds\x1b[0m…=900`
  // contains a literal `0` inside the reset sequence, so reading "the first
  // number after the field name" out of the raw bytes yields 0 — reporting the
  // policy as disabled on the strength of the very line that proves it is on.
  // Found by running the product, not by a unit test (2026-08-15).
  const text = stripAnsi(logText ?? "");
  const sleep = text.match(IDLE_SLEEP_RE);
  const seconds = sleep ? Number(sleep[1]) : null;

  // How long after start-up the pool became ready. A non-lazy pool is built
  // BEFORE the relay connection, so it is ready immediately; a measurable gap
  // is what deferred (lazy) start looks like.
  let deferredPoolStartMs = null;
  let started = null;
  for (const line of text.split("\n")) {
    const s = line.match(STARTING_RE);
    if (s) {
      started = Date.parse(s[1]);
      continue;
    }
    const r = line.match(POOL_READY_RE);
    if (r && started) {
      const ready = Date.parse(r[1]);
      if (!Number.isNaN(ready) && !Number.isNaN(started)) deferredPoolStartMs = ready - started;
      started = null;
    }
  }

  return {
    // `--idle-pool-sleep` is documented "Requires --lazy-pool; ignored
    // otherwise", so the sleep firing is proof of both.
    lazyPool: seconds != null && seconds > 0 ? true : null,
    idlePoolSleepSeconds: seconds != null && seconds > 0 ? seconds : null,
    deferredPoolStartMs,
    quote: sleep ? sleep[0].trim() : null,
  };
}

// ESC [ … m. Written from a char code on purpose: a literal escape byte in
// source is invisible in most editors and diff views, which is a poor place to
// hide the thing that decides whether AC-41 reads as on or off.
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function stripAnsi(value) {
  return String(value).replace(ANSI_RE, "");
}

// AC-40: the Buzz build the room was verified against.
//
// These binaries carry no embedded FileVersion or ProductVersion on this
// install, which is why cycle 2 could not re-verify the pin and flagged it
// honestly. Content addressing does not depend on the vendor shipping metadata.
export function fingerprintBinary(file) {
  if (!file || !existsSync(file)) return null;
  const bytes = readFileSync(file);
  return {
    file,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    modified: statSync(file).mtime.toISOString(),
  };
}

// FIX-97 (AC-40, AC-42): the pin is COMPARED, not merely printed.
//
// The proof it matters: Buzz on the dev box silently updated mid-project
// (2026-08-21) and `doctor` printed `ok` before and after with different
// hashes — it described the build and compared nothing, so cycles 1-8 ran
// against a build nobody chose. The comparison lives here, pure, so the
// wording and every branch are testable without binaries on disk.
//
//   • no pin        → "unpinned", a visible warning — never a silent ok.
//   • all match     → "pinned", naming the version the room is verified for.
//   • any mismatch  → "drift", naming BOTH sides per binary; a pinned binary
//                     that is missing is drift too. The caller points at the
//                     AC-42 re-audit checklist, because a pin bump is a
//                     checklist, not a sentiment.
export function buildPinCheck({ pin = null, fingerprints = {} }) {
  if (!pin) {
    return {
      state: "unpinned",
      detail:
        "no buzzBuild pin in the config — the room is UNPINNED and a silent Buzz update " +
        'would go unnoticed. Record { "buzzBuild": { "version": …, "sha256": { "buzz.exe": …, ' +
        '"buzz-acp.exe": … } } } to make drift fail loudly.',
    };
  }
  const results = [];
  let ok = true;
  for (const [name, expected] of Object.entries(pin.sha256 ?? {})) {
    const actual = fingerprints[name]?.sha256 ?? null;
    if (!actual) {
      ok = false;
      results.push({ name, state: "missing", expected, actual: null });
    } else if (actual !== expected) {
      ok = false;
      results.push({ name, state: "drift", expected, actual });
    } else {
      results.push({ name, state: "match", expected, actual });
    }
  }
  return { state: ok ? "pinned" : "drift", version: pin.version ?? null, results };
}
