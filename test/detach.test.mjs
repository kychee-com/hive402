// FIX-128 — `up` starts the node and RETURNS.
//
// ── The ask ────────────────────────────────────────────────────────────────
//
// Barry, once it finally ran from his own terminal: "I want it run and exit, not
// stuck in ctrl-c."
//
// ── What was holding the terminal, and why ─────────────────────────────────
//
// `cmdUp` called `sup.run()` and never returned, printing "Ctrl-C to stop", with
// agents spawned `detached: false` so the whole tree died with the console. That
// was deliberate: cycle 1's TR-003 found a `buzz-acp` still connected SEVEN AND
// A HALF HOURS after the session that started it, invisible and unstoppable and
// answering under the agent's identity. Two live harnesses under one identity
// answer every message twice. Owning the tree from the terminal made that
// impossible.
//
// ── Why it is safe to detach now ───────────────────────────────────────────
//
// The thing that made detaching dangerous was that `hive402 down` could not be
// trusted. It runs in a DIFFERENT process and knows only the pid file, and that
// file used to be written once at startup — so after any relaunch it named a
// dead pid while the real process ran untracked. That is fixed: the file is
// written wherever `#children` changes, `status` catches recycled pids through
// `startedAt`, and `down` separates stopped from already-gone from stale.
//
// The safety net that replaces "the terminal owns it" is the guard that refuses
// to start a second node while one is watching the room.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { relaunchArgv, spawnOptions, readStartup, tailFrom, WATCHING_MARKER } from "../src/node/detach.mjs";

// ── The command the parent re-runs ────────────────────────────────────────

test("the relaunched child runs in the FOREGROUND, or nothing would ever watch", () => {
  // The child IS the node. If it detached in turn, every `up` would fork
  // forever and none of them would watch anything.
  const argv = relaunchArgv({ cli: "C:\\cli.mjs", flags: {} });
  assert.ok(argv.includes("--foreground"), `missing --foreground in ${argv.join(" ")}`);
  assert.equal(argv[0], "C:\\cli.mjs");
  assert.equal(argv[1], "up");
});

test("the flags that decide behaviour are carried through", () => {
  // A detached start that quietly used a DIFFERENT config from the one asked
  // for would be the worst kind of wrong: it would work, against the wrong room.
  const argv = relaunchArgv({ cli: "C:\\cli.mjs", flags: { config: "D:\\mine.json", poll: 500 } });
  assert.ok(argv.includes("--config"));
  assert.equal(argv[argv.indexOf("--config") + 1], "D:\\mine.json");
  assert.ok(argv.includes("--poll"));
  assert.equal(argv[argv.indexOf("--poll") + 1], "500");
});

test("flags that were not given are not invented", () => {
  const argv = relaunchArgv({ cli: "C:\\cli.mjs", flags: {} });
  assert.equal(argv.includes("--config"), false);
  assert.equal(argv.includes("--poll"), false);
});

test("--foreground is never doubled if it was already asked for", () => {
  const argv = relaunchArgv({ cli: "C:\\cli.mjs", flags: { foreground: true } });
  assert.equal(argv.filter((a) => a === "--foreground").length, 1);
});

// ── How it is spawned ─────────────────────────────────────────────────────

test("the child is detached and hidden, on every platform", () => {
  // A console window appeared on Barry's desktop the moment this shipped, and
  // the first correction dropped `detached` on Windows — after which the node
  // DIED with the terminal that started it, which is the entire thing FIX-128
  // exists to prevent. Both readings were wrong.
  //
  // The window was never this process. It was `buzz-acp.exe`, spawned by the
  // node with no `windowsHide` of its own: while the node ran in the foreground
  // the harness quietly reused the operator's console, and the moment the node
  // had none the harness was handed a new, visible one. Fixed on that spawn.
  //
  // `detached` is what gives this process its own group and its own absent
  // console, so it survives the terminal closing. Without it the child stays
  // attached to the parent's console and dies with it.
  const opts = spawnOptions({ logFd: 7 });
  assert.equal(opts.detached, true, "without this the node dies with the terminal");
  assert.equal(opts.windowsHide, true, "and without this it gets a window of its own");
});

test("the agent harness is spawned hidden too, which is where the window came from", () => {
  // The actual regression guard. `buzz-acp.exe` is spawned by the supervisor,
  // and a missing `windowsHide` there is invisible until the node stops having a
  // console to lend it — so it survived every foreground run and appeared the
  // instant `up` went to the background.
  const src = readFileSync(new URL("../src/node/supervisor.mjs", import.meta.url), "utf8");
  const spawnCall = src.slice(src.indexOf("cwd: workDir"), src.indexOf("cwd: workDir") + 200);
  assert.match(spawnCall, /windowsHide:\s*true/, `the harness spawn must hide its console:\n${spawnCall}`);
});

test("the child NEVER inherits the terminal", () => {
  // Inherited stdio keeps a handle on the console, so closing the window can
  // still take the node with it — and output would keep arriving in a terminal
  // the person has moved on from.
  const opts = spawnOptions({ logFd: 7 });
  assert.equal(opts.stdio.includes("inherit"), false, `stdio was ${JSON.stringify(opts.stdio)}`);
  assert.equal(opts.stdio[0], "ignore", "nothing will ever type at it");
  assert.deepEqual(opts.stdio.slice(1), [7, 7], "both streams go to the log file");
});

// ── Deciding that it started ──────────────────────────────────────────────

const startedOutput = [
  "hive402: 1 agent(s) up — smith",
  "  watching 1 channel(s) — b86d8eda-5f05-496c-af45-ef4442ad5876",
  "  smith: addressable · research=true build=false · pid 4242",
  `hive402: ${WATCHING_MARKER}`,
].join("\n");

test("the parent reports the CHILD's own summary, not a guess", () => {
  // "started" with no confirmation is how a broken start goes unnoticed. The
  // child is the only thing that knows whether the agent is addressable, so its
  // output is what the person sees.
  const seen = readStartup({ text: startedOutput, exited: false });
  assert.equal(seen.started, true);
  assert.match(seen.output, /smith: addressable/);
  assert.match(seen.output, /watching 1 channel/);
});

test("the Ctrl-C line is not echoed back to somebody who is not holding it", () => {
  const seen = readStartup({ text: startedOutput, exited: false });
  assert.doesNotMatch(seen.output, /Ctrl-C/i, `a detached start must not mention Ctrl-C:\n${seen.output}`);
});

test("output before the marker is NOT a successful start", () => {
  // The half-written case. Reporting success on the first line would announce a
  // node that is still resolving keys and may yet refuse.
  const seen = readStartup({ text: "hive402: 1 agent(s) up — smith\n", exited: false });
  assert.equal(seen.started, false);
});

test("a child that DIES before watching is a failure, with what it said", () => {
  // The start still has to be able to fail. Barry spent an afternoon on a `up`
  // that refused; if detaching had swallowed that refusal he would have had a
  // silent no-op instead.
  const seen = readStartup({
    text: "hive402: cannot start: no usable key for node.\n",
    exited: true,
  });
  assert.equal(seen.started, false);
  assert.equal(seen.failed, true);
  assert.match(seen.output, /cannot start/);
});

test("a child that dies AFTER the marker is still a success", () => {
  // It said it was watching. Whatever happened next is `status` and `down`'s
  // business, not a reason to tell the person the start failed.
  const seen = readStartup({ text: startedOutput, exited: true });
  assert.equal(seen.started, true);
  assert.equal(seen.failed, false);
});

// ── Reading the log from where this run began ─────────────────────────────

test("the log is sliced by BYTES, not by characters", () => {
  // FOUND BY RUNNING IT. The first detached start printed its opening line as
  // "2: note — …", with six bytes of "hive40" missing.
  //
  // The offset comes from `statSync().size`, a BYTE count, and it was being
  // handed to `String.slice`, a CHARACTER index. The log is full of em-dashes,
  // each three bytes and one character, so every one of them shifted the two
  // apart and the slice cut into the new content.
  const prior = Buffer.from("hive402: stopped — smith:1 — node:2\n", "utf8");
  const fresh = Buffer.from("hive402: 1 agent(s) up — smith\n", "utf8");
  const whole = Buffer.concat([prior, fresh]);

  const seen = tailFrom(() => whole, "irrelevant", prior.length);
  assert.equal(seen, fresh.toString("utf8"), `character-indexing would clip this: got "${seen}"`);
  assert.ok(seen.startsWith("hive402:"), "the first line must survive intact");
  assert.ok(prior.length > prior.toString("utf8").length, "the fixture must actually be multi-byte");
});

test("a log that does not exist yet is silence, not a crash", () => {
  // The parent polls from the moment it spawns, and the child may not have
  // written anything at all yet.
  const seen = tailFrom(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }, "missing", 0);
  assert.equal(seen, "");
});

test("silence is neither started nor failed while the child still lives", () => {
  // The caller polls; "nothing yet" must not resolve either way, or a slow
  // relay would read as a failure.
  const seen = readStartup({ text: "", exited: false });
  assert.equal(seen.started, false);
  assert.equal(seen.failed, false);
});
