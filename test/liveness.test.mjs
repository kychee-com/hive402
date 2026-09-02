// Is the pid in the pid file still OUR process? (fix cycle 4, DD-25)
//
// These tests deliberately use REAL operating-system processes — real pids that
// really exited, and real live processes that really are not hive402 — because
// the defect they cover is precisely a disagreement between a recorded pid and
// reality. The cycle-3 test for this branch injected `isAlive: () => true`, so
// it asserted the refusal path while stubbing away the only question that can
// be wrong; `up` then spent a morning refusing to start behind pid 36916, which
// `tasklist` reported as gone (O-1).
//
// Nothing here may stub the probe except the two cases that are ABOUT the probe
// failing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyRecorded,
  identifyProcesses,
  looksLikeAgent,
  looksLikeNode,
} from "../src/node/liveness.mjs";

const running = [];

// A real, live process that is emphatically NOT a hive402 node.
function spawnStranger() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  running.push(child);
  return child;
}

// A real, live process whose command line genuinely looks like `hive402 up`:
// a throwaway `bin/cli.mjs` that only sleeps, invoked with the same argv shape
// the node is really started with. The point is to exercise the matcher against
// an actual OS command line rather than a hand-written string.
function spawnNodeShaped() {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-fakecli-"));
  mkdirSync(path.join(dir, "bin"));
  const script = path.join(dir, "bin", "cli.mjs");
  writeFileSync(script, "setTimeout(() => {}, 120000);\n", "utf8");
  const child = spawn(process.execPath, [script, "up", "--config", path.join(dir, "hive402.config.json")], {
    stdio: "ignore",
  });
  running.push(child);
  return child;
}

// A real pid that is genuinely gone: spawned, exited, and reaped.
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

test.after(() => {
  for (const child of running) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
});

// --- the probe itself -------------------------------------------------------

test("the probe reads a live process's real command line from the OS", async () => {
  const child = spawnNodeShaped();
  const found = identifyProcesses([child.pid]);
  assert.ok(found, "the probe should be available on this platform");
  const info = found.get(child.pid);
  assert.ok(info, `expected the OS to report pid ${child.pid}`);
  assert.match(info.commandLine, /cli\.mjs/, `got: ${info.commandLine}`);
});

test("the probe reports a genuinely exited pid as absent", async () => {
  const pid = await deadPid();
  const found = identifyProcesses([pid]);
  assert.ok(found, "the probe should be available on this platform");
  assert.equal(found.get(pid), undefined, "an exited process must not be reported as present");
});

// --- the signature ----------------------------------------------------------

test("the node signature matches how the node is really launched", () => {
  // Copied from the live rig (2026-08-16, pid 5632) rather than invented.
  assert.ok(
    looksLikeNode(
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Workspace-Kychee\\hive402\\bin\\cli.mjs up --config hive402.config.json',
    ),
  );
  assert.ok(looksLikeNode("node /usr/lib/node_modules/hive402/bin/cli.mjs up"));
  assert.ok(!looksLikeNode("node -e setTimeout(() => {}, 120000)"));
  assert.ok(!looksLikeNode("C:\\Windows\\explorer.exe"));
});

test("the agent signature matches how an agent is really launched", () => {
  // Live rig (2026-08-16, pid 36572).
  assert.ok(
    looksLikeAgent(
      "C:\\Users\\volin\\AppData\\Local\\Buzz\\buzz-acp.exe --channels b86d8eda --agent-command node --lazy-pool",
    ),
  );
  assert.ok(!looksLikeAgent("node -e setTimeout(() => {}, 120000)"));
});

// --- the decision -----------------------------------------------------------

test("a recorded pid whose process really exited is classified gone", async () => {
  const pid = await deadPid();
  const verdict = classifyRecorded({ pid, kind: "node", recordedAt: Date.now() });
  assert.equal(verdict.state, "gone", verdict.detail);
});

test("a recorded pid now held by an unrelated live process is classified reused", () => {
  // THE O-1 CASE. `process.kill(pid, 0)` answers "does *a* process hold this
  // number", which is a different question from "is my node still running" —
  // and Windows recycles pids briskly, so an overnight rig hits this.
  const child = spawnStranger();
  const verdict = classifyRecorded({ pid: child.pid, kind: "node", recordedAt: Date.now() });
  assert.equal(verdict.state, "reused", verdict.detail);
  assert.match(verdict.detail, /another process|not a hive402/i);
});

test("a live process that really is a hive402 node is classified ours", () => {
  const child = spawnNodeShaped();
  const verdict = classifyRecorded({ pid: child.pid, kind: "node", recordedAt: Date.now() });
  assert.equal(verdict.state, "ours", verdict.detail);
});

test("a matching command line that started AFTER the record is still reused", () => {
  // Pid reuse onto the same program: the command line alone cannot tell these
  // apart, but a process cannot have started after the file that recorded it.
  const child = spawnNodeShaped();
  const verdict = classifyRecorded({ pid: child.pid, kind: "node", recordedAt: Date.now() - 3600_000 });
  assert.equal(verdict.state, "reused", verdict.detail);
  assert.match(verdict.detail, /started .*after/i);
});

test("an unreadable probe over a live pid is unconfirmed, never assumed dead", () => {
  // The failure direction matters: `up` must not create a second node because a
  // powershell call failed, so "cannot tell" is its own answer.
  const child = spawnStranger();
  const verdict = classifyRecorded({
    pid: child.pid,
    kind: "node",
    recordedAt: Date.now(),
    identify: () => null, // probe unavailable
  });
  assert.equal(verdict.state, "unconfirmed", verdict.detail);
});

test("an unreadable probe over a dead pid is still gone", async () => {
  const pid = await deadPid();
  const verdict = classifyRecorded({ pid, kind: "node", recordedAt: Date.now(), identify: () => null });
  assert.equal(verdict.state, "gone", verdict.detail);
});
