// Who is that pid, really? (fix cycle 4, DD-25)
//
// Every lifecycle command reads a pid out of `hive402.pid.json` and then has to
// decide what it means. Until now they all asked `process.kill(pid, 0)`, which
// answers a subtly different question — "does *a* process hold this number" —
// and the gap between those two questions is O-1: after an overnight idle-exit
// `up` refused to start behind pid 36916 for a process `tasklist` reported as
// gone, so the normal morning-after state of the demo rig was "wedged, claiming
// to be running". The same gap let `down` kill BY NUMBER, which on a recycled
// pid means terminating an innocent process and reporting it as ours.
//
// So a recorded pid is treated as a claim to be checked. The check has two
// independent halves, because either one alone is defeatable:
//
//   1. WHAT is it — the process command line, read with the OS's own tool. This
//      is the surface `doctor` already uses for AC-41/AC-42, for the same
//      reason: the answer does not depend on trusting hive402.
//   2. WHEN did it start — a process cannot have started after the file that
//      recorded it. This is what catches a pid recycled onto the SAME program,
//      which no amount of command-line matching can see.
//
// The probe can also fail to answer, and "cannot tell" is a third answer rather
// than a silent false. Callers pick their own failure direction from it: `up`
// refuses (never create a second node on a guess), `down` proceeds (it was
// asked to stop things). See DD-25.

import { spawnSync } from "node:child_process";

// A process cannot start after the record that names it — but allow a little
// slack for clock jitter. Erring high errs toward "this is ours", which makes
// `up` refuse rather than stack a second node.
const START_SLACK_MS = 2000;

// Is anything at all holding this number? Cheap, and deliberately NOT trusted
// on its own — it is the fallback for when the real probe cannot run.
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, kills nothing
    return true;
  } catch (err) {
    // EPERM means a process IS there, we simply may not signal it. Reading that
    // as "dead" is the same class of mistake in the opposite direction.
    return err?.code === "EPERM";
  }
}

// How the node itself appears in a process list. Generous on purpose: a false
// "that is a node" makes `up` refuse (safe), a false "that is not a node" makes
// it reclaim a pid file out from under a live node (two nodes, every message
// relayed twice — the failure FIX-11 exists to prevent).
export function looksLikeNode(commandLine) {
  if (!commandLine) return false;
  if (/hive402/i.test(commandLine)) return true;
  return /(^|[\\/\s"'])cli\.mjs(["']|\s|$)/i.test(commandLine) && /(^|\s)["']?up["']?(\s|$)/.test(commandLine);
}

// How a launched agent appears: the node spawns the Buzz harness itself, so the
// harness binary is the signature.
export function looksLikeAgent(commandLine) {
  return Boolean(commandLine) && /buzz-acp/i.test(commandLine);
}

// Ask the OS about a set of pids in ONE call.
//
// Returns a Map(pid -> { commandLine, startedAt }) holding only the pids that
// are actually running, or `null` when the probe itself could not run — which
// is a different answer from "none of them are running" and must not be
// flattened into one.
export function identifyProcesses(pids, { run = spawnSync } = {}) {
  const wanted = [...new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 0))];
  if (wanted.length === 0) return new Map();

  const probe = process.platform === "win32" ? winProbe(wanted, run) : posixProbe(wanted, run);
  // `null` is "the probe could not run"; `""` is "it ran and nothing matched".
  // Collapsing those two into one falsy check reports every dead pid as
  // unknown, which is how `up` would keep refusing behind a pid that is gone.
  if (probe == null) return null;

  const found = new Map();
  for (const line of probe.split("\n")) {
    const row = parseRow(line.trim());
    if (row && wanted.includes(row.pid)) found.set(row.pid, { commandLine: row.commandLine, startedAt: row.startedAt });
  }
  return found;
}

// One pid's identity. `null` = the probe could not answer at all.
export function identifyProcess(pid, opts) {
  const found = identifyProcesses([pid], opts);
  if (found === null) return null;
  const info = found.get(pid);
  return info ? { present: true, ...info } : { present: false, commandLine: null, startedAt: null };
}

// A per-pid lookup backed by a single probe, for the commands that hold several
// pids at once (`down`, `doctor`) and should not pay for a sub-process each.
export function makeIdentifier(pids, opts) {
  const found = identifyProcesses(pids, opts);
  if (found === null) return () => null;
  return (pid) => {
    const info = found.get(pid);
    return info ? { present: true, ...info } : { present: false, commandLine: null, startedAt: null };
  };
}

// What a recorded pid actually is. One of four states:
//
//   ours         a live process that really is this product's `kind`
//   gone         nothing is running on that number
//   reused       something IS running there, but provably not what we recorded
//   unconfirmed  something is running there and we could not find out what
//
// `recordedAt` is the pid file's `startedAt`; without it the start-time half of
// the check is simply skipped rather than guessed at.
export function classifyRecorded({
  pid,
  kind = "node",
  recordedAt = null,
  identify = identifyProcess,
  isAlive = isPidAlive,
} = {}) {
  if (!pid) return { state: "gone", detail: "no pid was recorded" };

  const info = identify(pid);

  if (info == null) {
    return isAlive(pid)
      ? {
          state: "unconfirmed",
          detail: `pid ${pid} is alive, but this machine could not report what it is`,
        }
      : { state: "gone", detail: `pid ${pid} is not running` };
  }

  if (!info.present) return { state: "gone", detail: `pid ${pid} is not running` };

  if (recordedAt && info.startedAt && info.startedAt > recordedAt + START_SLACK_MS) {
    const after = Math.round((info.startedAt - recordedAt) / 1000);
    return {
      state: "reused",
      detail:
        `pid ${pid} belongs to another process — it started ${after}s after this record ` +
        `was written, so it cannot be the one we recorded`,
    };
  }

  const matches = kind === "agent" ? looksLikeAgent(info.commandLine) : looksLikeNode(info.commandLine);
  if (!matches) {
    return {
      state: "reused",
      detail: `pid ${pid} now belongs to another process, not a hive402 ${kind} (${summarise(info.commandLine)})`,
    };
  }

  return { state: "ours", detail: `pid ${pid} is a live hive402 ${kind}` };
}

// --- the OS probes ----------------------------------------------------------

// `Get-CimInstance Win32_Process` is the same tool `doctor` reads the AC-41
// policy with, and the same one an operator would reach for by hand. It reports
// only LIVE processes, which is what makes it a better liveness check than
// `kill(0)` as well as an identity check.
function winProbe(pids, run) {
  const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { ` +
    `'{0}|{1}|{2}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ` +
    `($_.CommandLine -replace '[\\r\\n]', ' ') }`;
  return output(run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }));
}

// `lstart` is the portable absolute start time (`ps -o etimes` is Linux-only).
function posixProbe(pids, run) {
  const text = output(
    run("ps", ["-o", "pid=,lstart=,args=", "-p", pids.join(",")], { encoding: "utf8" }),
  );
  if (text == null) return null;
  return text
    .split("\n")
    .map((line) => {
      // "<pid> Sat Aug 16 08:40:51 2026 <args…>" — lstart is a fixed 5 fields.
      const m = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
      if (!m) return "";
      const at = Date.parse(m[2]);
      return `${m[1]}|${Number.isNaN(at) ? "" : at}|${m[3]}`;
    })
    .join("\n");
}

function output(result) {
  if (!result || result.error || result.status !== 0) return null;
  return String(result.stdout ?? "");
}

function parseRow(line) {
  if (!line) return null;
  const first = line.indexOf("|");
  const second = line.indexOf("|", first + 1);
  if (first < 1 || second < 0) return null;
  const pid = Number(line.slice(0, first));
  if (!Number.isInteger(pid)) return null;
  const at = Number(line.slice(first + 1, second));
  return {
    pid,
    startedAt: Number.isFinite(at) && at > 0 ? at : null,
    commandLine: line.slice(second + 1).trim() || null,
  };
}

function summarise(commandLine) {
  if (!commandLine) return "no command line";
  return commandLine.length > 80 ? `${commandLine.slice(0, 77)}…` : commandLine;
}
