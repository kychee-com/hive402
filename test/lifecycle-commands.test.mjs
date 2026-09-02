// `hive402 down` and `hive402 status` against a pid file that disagrees with
// reality (fix cycle 4, O-2 / DD-25).
//
// `stopFromPidFile` had NO tests at all, which is how it came to report
// `stopped node:36916` for a process that had exited overnight — a false
// statement at the exact moment an operator is debugging. Worse, and not in the
// findings: it called `process.kill(pid)` on a recorded number without checking
// whose number it now was, so a recycled pid meant `hive402 down` terminating
// an unrelated process and reporting it as ours.
//
// As in liveness.test.mjs, the processes here are real. A fake pid file paired
// with a fake liveness answer cannot reproduce a disagreement between them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readStatus, stopFromPidFile } from "../src/node/runtime.mjs";

const running = [];

function spawnStranger() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  running.push(child);
  return child;
}

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

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

function stateWith({ node = null, agents = [], startedAt = Date.now() } = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-state-"));
  writeFileSync(
    path.join(stateDir, "hive402.pid.json"),
    `${JSON.stringify({ node, startedAt, agents }, null, 2)}\n`,
    "utf8",
  );
  return stateDir;
}

const config = () => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: "n".repeat(64), privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
  rooms: [
    {
      channel: "b86d8eda-5f05-496c-af45-ef4442ad5876",
      agents: [
        {
          name: "spike",
          pubkey: "a".repeat(64),
          ownerPubkey: "o".repeat(64),
          privateKeyRef: "env:TEST_AGENT_KEY",
          research: true,
          build: false,
          crossOwnerAsks: "owner-approves",
          selfInitiated: "asks-owner",
          replyMode: "addressed-only",
        },
      ],
    },
  ],
});

test.after(() => {
  for (const child of running) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
});

// --- O-2: `down` must not claim to have stopped a corpse ---------------------

test("down reports a node that had already exited as gone, not stopped", async () => {
  // THE O-2 CASE, verbatim: `hive402: stopped node:36916` for a process that
  // died overnight.
  const stateDir = stateWith({ node: await deadPid() });
  const stopped = stopFromPidFile(stateDir);

  const node = stopped.find((s) => s.name === "node");
  assert.ok(node, `expected the node to be reported, got ${JSON.stringify(stopped)}`);
  assert.notEqual(node.state, "stopped", "nothing was stopped — it was already gone");
  assert.equal(node.state, "gone");
});

test("down really does stop a node that really is running", async () => {
  const node = spawnNodeShaped();
  const exited = new Promise((resolve) => node.on("exit", resolve));
  const stateDir = stateWith({ node: node.pid });

  const stopped = stopFromPidFile(stateDir);
  assert.equal(stopped.find((s) => s.name === "node")?.state, "stopped");
  await exited; // and it is actually dead, not merely reported as such
});

test("down refuses to kill a pid that now belongs to someone else", async () => {
  // Killing by number is how a recycled pid becomes somebody else's outage.
  const stranger = spawnStranger();
  const stateDir = stateWith({ node: stranger.pid });

  const stopped = stopFromPidFile(stateDir);
  assert.equal(stopped.find((s) => s.name === "node")?.state, "stale");

  // Give a kill that should not have happened time to land.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(stranger.exitCode, null, "an unrelated process must be left alone");
  assert.equal(stranger.killed, false);
});

test("down clears the pid file whatever the outcome", async () => {
  const stateDir = stateWith({ node: await deadPid(), agents: [{ name: "spike", pid: await deadPid() }] });
  stopFromPidFile(stateDir);
  assert.ok(!existsSync(path.join(stateDir, "hive402.pid.json")));
});

test("down reports each agent's own outcome, not one verdict for all", async () => {
  const stranger = spawnStranger();
  const stateDir = stateWith({
    node: await deadPid(),
    agents: [
      { name: "spike", pid: await deadPid() },
      { name: "spike2", pid: stranger.pid },
    ],
  });

  const stopped = stopFromPidFile(stateDir);
  assert.equal(stopped.find((s) => s.name === "spike")?.state, "gone");
  assert.equal(stopped.find((s) => s.name === "spike2")?.state, "stale");
});

// --- the same lie, one command over: `status` --------------------------------

test("status does not report a node as running when only its record survives", async () => {
  // `running` was `Boolean(pidFileExists)`, so an overnight-dead rig reported
  // itself up. Same defect as O-2, different command.
  const stateDir = stateWith({ node: await deadPid() });
  const status = await readStatus({ config: config(), stateDir });
  assert.equal(status.running, false);
});

test("status reports a live node as running", async () => {
  const node = spawnNodeShaped();
  const stateDir = stateWith({ node: node.pid });
  const status = await readStatus({ config: config(), stateDir });
  assert.equal(status.running, true);
});
