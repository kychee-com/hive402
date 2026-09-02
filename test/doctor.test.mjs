// Making AC-41/AC-42 and AC-40 checkable (DD-18, FIX-19/FIX-21, fix cycle 2).
//
// F-005 was re-opened for a good reason. Cycle 1 told the Red Team its
// `CommandLine` evidence was invalid because these policies travel by
// environment variable; cycle 2 read the surface we named instead — the
// harness's own `buzz-acp starting:` line — and found it prints 21 settings and
// none of these three, not even at their zero default. So the prescribed
// surface cannot confirm the policy either way, which is TR-004.
//
// The answer is not a better log-reading technique. It is to make the ORDINARY
// surface correct: pass the policy as flags (visible in any process listing),
// report it from the product, and quote the harness's own words back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { lifetimePolicyArgs, lifetimePolicyReport, LIFETIME_POLICY_KEYS } from "../src/launcher/env.mjs";
import {
  fingerprintBinary,
  harnessLifecycleEvidence,
  lifecycleCheck,
  lifecycleSubjects,
} from "../src/node/doctor.mjs";

// ── The two tables can never disagree ─────────────────────────────────────

test("every policy passed as a flag carries the same value as its env var", () => {
  // The policy now lives in two places so it can be observed in two ways. One
  // table feeds both, and this is the assertion that keeps them honest.
  const args = lifetimePolicyArgs();
  for (const { flag, value, boolean: isBool } of lifetimePolicyReport()) {
    const at = args.indexOf(flag);
    assert.ok(at >= 0, `${flag} must be on the command line`);
    if (isBool) {
      assert.equal(value, "true", `${flag} is only passed when its env value is true`);
    } else {
      assert.equal(args[at + 1], value, `${flag} must carry the env table's value`);
    }
  }
});

test("the policies that need to be visible on the command line are exactly these", () => {
  // buzz-acp's Config::summary() prints presence and typing, so those stay
  // observable without help. It prints nothing for the first three.
  //
  // `--multiple-event-handling` IS printed by the summary line (as `meh=`), and
  // is passed as a flag anyway: it decides whether two people's requests can be
  // merged into one turn (DD-24), which makes it the one setting most worth
  // being able to check with a standard OS tool and nobody's word.
  const flags = lifetimePolicyArgs().filter((a) => a.startsWith("--"));
  assert.deepEqual(flags.sort(), [
    "--exit-after-inactivity",
    "--idle-pool-sleep",
    "--lazy-pool",
    "--multiple-event-handling",
  ]);
});

test("the flag table only ever names policies the env table already audits", () => {
  for (const { env } of lifetimePolicyReport()) {
    assert.ok(LIFETIME_POLICY_KEYS.includes(env), `${env} must be in the audited AC-42 table`);
  }
});

test("idle-pool-sleep is non-zero, which is what AC-41 actually requires", () => {
  const idle = lifetimePolicyReport().find((p) => p.flag === "--idle-pool-sleep");
  assert.ok(Number(idle.value) > 0, "AC-41: a non-zero idle pool sleep window");
});

// ── Checking the live process ─────────────────────────────────────────────

test("a command line carrying every policy passes the check", () => {
  const commandLine =
    "buzz-acp.exe --channels abc --agent-command node --agent-args x " +
    "--lazy-pool --idle-pool-sleep 900 --exit-after-inactivity 3600 " +
    "--multiple-event-handling queue";
  const result = lifecycleCheck({ commandLine });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /lazy-pool/);
});

test("a command line missing a policy fails the check and names what is missing", () => {
  const commandLine = "buzz-acp.exe --channels abc --lazy-pool --idle-pool-sleep 900";
  const result = lifecycleCheck({ commandLine });
  assert.equal(result.ok, false);
  assert.match(result.detail, /--exit-after-inactivity/);
});

test("a policy present with the WRONG value fails rather than passing on presence alone", () => {
  const commandLine = "buzz-acp.exe --lazy-pool --idle-pool-sleep 0 --exit-after-inactivity 3600";
  const result = lifecycleCheck({ commandLine });
  assert.equal(result.ok, false);
  assert.match(result.detail, /idle-pool-sleep/);
});

test("no command line at all is reported as unknown, never as a pass", () => {
  assert.equal(lifecycleCheck({ commandLine: null }).ok, false);
});

// ── The harness's own corroboration ───────────────────────────────────────

test("the harness's idle-pool-sleep line is recognised as independent proof", () => {
  // This exact line was sitting in .hive402/logs/spike.log during cycle 2, twice.
  // It is only reachable when lazy_pool is on AND idle_pool_sleep is non-zero,
  // so it settles the question the startup line could not.
  const log = [
    "2026-08-15T16:31:16Z  INFO buzz_acp: buzz-acp starting: relay=ws://localhost:3000 presence=true typing=true",
    "2026-08-15T16:31:37Z  INFO buzz_acp: agent_pool_ready agents=1",
    "2026-08-15T17:05:56Z  INFO buzz_acp: idle pool sleep bound reached — tearing pool back to lazy state idle_pool_sleep_seconds=900",
  ].join("\n");
  const evidence = harnessLifecycleEvidence({ logText: log });
  assert.equal(evidence.idlePoolSleepSeconds, 900);
  assert.equal(evidence.lazyPool, true);
  assert.match(evidence.quote, /idle pool sleep bound reached/);
});

test("the REAL log line parses — the harness colours its field names", () => {
  // REGRESSION (found by running it, 2026-08-15): the harness writes
  // `…idle_pool_sleep_seconds\x1b[0m\x1b[2m=\x1b[0m900`. The reset code `[0m`
  // contains a digit, so a naive "skip non-digits then read the number" reads
  // the ZERO out of the escape sequence and reports a disabled policy — turning
  // the strongest evidence we have into evidence of the opposite. Strip first.
  const raw =
    "2026-08-15T17:05:56Z \x1b[32m INFO\x1b[0m \x1b[2mbuzz_acp\x1b[0m\x1b[2m:\x1b[0m " +
    "idle pool sleep bound reached — tearing pool back to lazy state " +
    "\x1b[3midle_pool_sleep_seconds\x1b[0m\x1b[2m=\x1b[0m900";
  const evidence = harnessLifecycleEvidence({ logText: raw });
  assert.equal(evidence.idlePoolSleepSeconds, 900, "must read 900, not the 0 inside an escape code");
  assert.equal(evidence.lazyPool, true);
  assert.ok(!/\x1b|\[[0-9;]*m/.test(evidence.quote), `the quote must be readable: ${JSON.stringify(evidence.quote)}`);
});

test("a log with no such line reports no evidence rather than inventing it", () => {
  const evidence = harnessLifecycleEvidence({ logText: "INFO buzz_acp: buzz-acp starting: presence=true" });
  assert.equal(evidence.idlePoolSleepSeconds, null);
  assert.equal(evidence.lazyPool, null);
});

test("a deferred pool start is reported as supporting evidence for lazy pool", () => {
  // Under a non-lazy pool the pool is initialised BEFORE the relay connection is
  // made, so `agent_pool_ready` precedes the first subscription. A gap after the
  // startup line is what a lazy pool looks like at boot.
  const log = [
    "2026-08-15T16:31:16.000Z  INFO buzz_acp: buzz-acp starting: relay=ws://x",
    "2026-08-15T16:31:37.000Z  INFO buzz_acp: agent_pool_ready agents=1",
  ].join("\n");
  assert.ok(harnessLifecycleEvidence({ logText: log }).deferredPoolStartMs >= 20000);
});

// ── AC-40: the pin becomes a repeatable check (FIX-21) ────────────────────

test("a binary is fingerprinted by content, since this install carries no version marker", () => {
  // T-013: the Red Team could not re-verify the pinned Buzz build because
  // `Get-Item .VersionInfo` returns nothing for these binaries. A content hash
  // is something anyone can recompute and compare across cycles.
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-fp-"));
  const file = path.join(dir, "buzz.exe");
  writeFileSync(file, "pretend binary contents");
  const fp = fingerprintBinary(file);
  assert.equal(fp.size, 23);
  assert.match(fp.sha256, /^[0-9a-f]{64}$/);
  assert.ok(fp.modified);
});

test("the same bytes always fingerprint the same, different bytes never do", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-fp-"));
  const a = path.join(dir, "a.exe");
  const b = path.join(dir, "b.exe");
  writeFileSync(a, "same");
  writeFileSync(b, "same");
  assert.equal(fingerprintBinary(a).sha256, fingerprintBinary(b).sha256);
  writeFileSync(b, "different");
  assert.notEqual(fingerprintBinary(a).sha256, fingerprintBinary(b).sha256);
});

test("a missing binary fingerprints as absent rather than throwing", () => {
  assert.equal(fingerprintBinary(path.join(tmpdir(), "nope-does-not-exist.exe")), null);
});

// ── O-3: with the node down, say so — do not blame ghosts ─────────────────
//
// With every process gone overnight, `doctor` printed one lifecycle-policy FAIL
// per agent, naming pids that no longer existed:
//
//   FAIL  lifecycle policy for spike (pid 9632): could not read the agent
//         process's command line — run this while the node is up (…)
//
// The hint was right and the diagnosis inverted. The actual state is "no node
// is running", which is one fact, not two failures. As elsewhere in fix cycle 4
// these tests use real pids, because the bug is a record disagreeing with
// reality.

test("a pid file whose node really exited reports the node down, not agent failures", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const dead = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));

  const subjects = lifecycleSubjects({
    record: { node: dead, startedAt: Date.now(), agents: [{ name: "spike", pid: dead }] },
  });
  assert.equal(subjects.nodeDown, true);
  assert.equal(subjects.agents.length, 0, "no agent policy can be checked while the node is down");
  assert.match(subjects.detail, /no longer running/i);
});

test("no pid file at all is node-down, not an error", () => {
  const subjects = lifecycleSubjects({ record: null });
  assert.equal(subjects.nodeDown, true);
  assert.match(subjects.detail, /never been started|no pid file|not running/i);
});

test("a live node keeps its agents on the lifecycle check list", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-fakecli-"));
  mkdirSync(path.join(dir, "bin"));
  const script = path.join(dir, "bin", "cli.mjs");
  writeFileSync(script, "setTimeout(() => {}, 120000);\n", "utf8");
  const node = spawn(process.execPath, [script, "up"], { stdio: "ignore" });
  const agent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });

  try {
    const subjects = lifecycleSubjects({
      record: { node: node.pid, startedAt: Date.now(), agents: [{ name: "spike", pid: agent.pid }] },
    });
    assert.equal(subjects.nodeDown, false);
    // The agent pid is live but is not a buzz-acp, so it is reported as a stale
    // record rather than silently checked as though it were the agent.
    assert.equal(subjects.agents.length, 0);
    assert.equal(subjects.stale.length, 1);
    assert.equal(subjects.stale[0].name, "spike");
  } finally {
    node.kill();
    agent.kill();
  }
});
