// Starting the node without holding the terminal (FIX-128).
//
// ── What used to hold it, and why that was right ───────────────────────────
//
// `up` called `sup.run()` and never returned. Agents spawned `detached: false`,
// so the whole tree died with the console. That was not an oversight: cycle 1's
// TR-003 found a `buzz-acp` process still connected SEVEN AND A HALF HOURS after
// the session that started it — invisible, unstoppable, and answering under the
// agent's identity. Two live harnesses under one identity answer every message
// twice. Owning the tree from the terminal made that impossible by construction.
//
// ── Why it is safe to let go now ───────────────────────────────────────────
//
// What made detaching dangerous was not detaching. It was that `hive402 down`
// could not be trusted: it runs in a DIFFERENT process and knows only the pid
// file, and that file used to be written once at startup — so after any relaunch
// it named a dead pid while the real process ran untracked. Stopping a node you
// could not name is how TR-003 happened in the first place.
//
// That is fixed. The pid file is written wherever `#children` changes,
// `status` catches a recycled pid by comparing `startedAt` against the process's
// real start time, and `down` reports stopped, already-gone and stale as three
// different things. The guard that refuses to start a second node while one is
// watching the room is the safety net that replaces "the terminal owns it".
//
// ── Scope ──────────────────────────────────────────────────────────────────
//
// This survives closing the terminal. It does NOT survive a reboot or sleep, and
// nothing here should be read as claiming otherwise: always-on is the cloud
// phase, and that is a different product.

// The child's own last line of startup, and the parent's proof that the node is
// really watching rather than merely spawned. It is the CHILD that knows whether
// the agent is addressable, so its words are what the person sees.
export const WATCHING_MARKER = "watching the room.";

// The command the parent re-runs as a detached child.
//
// `--foreground` is not optional: the child IS the node. A child that detached
// in turn would fork forever and none of them would watch anything.
export function relaunchArgv({ cli, flags = {} }) {
  const argv = [cli, "up", "--foreground"];
  // Only what was actually given. Inventing a `--config` would be worse than
  // omitting it, because a detached node running against the WRONG room works
  // perfectly and is wrong.
  if (typeof flags.config === "string") argv.push("--config", flags.config);
  if (flags.poll !== undefined && flags.poll !== null) argv.push("--poll", String(flags.poll));
  return argv;
}

// How it is spawned. Both `detached` and the caller's `unref()` are required:
// the first gives the child its own process group so it outlives the parent, and
// without the second the parent's event loop stays alive waiting for it, which
// is exactly the thing being removed.
//
// stdio NEVER inherits. An inherited handle keeps the child tied to the console,
// so closing the window could still take the node with it, and its output would
// keep arriving in a terminal the person has moved on from.
export function spawnOptions({ logFd }) {
  return {
    // DETACHED EVERYWHERE, and the middle of this story is why.
    //
    // A console window appeared on Barry's desktop the moment this shipped, so
    // the first correction dropped `detached` on Windows — and the node then
    // DIED with the terminal that started it, which is the whole thing FIX-128
    // exists to prevent. Both readings were wrong.
    //
    // The window was never this process. It was `buzz-acp.exe`, which the node
    // spawns and which had no `windowsHide` of its own: while the node ran in
    // the foreground the harness quietly reused the operator's console, and the
    // moment the node had no console the harness was given a new, visible one.
    // Fixed where it belongs, on that spawn.
    //
    // `detached` is what gives this process its own group and its own (absent)
    // console, so it survives the terminal closing. Without it the child stays
    // attached to the parent's console and dies with it.
    detached: true,
    windowsHide: true,
    // Never `inherit`. An inherited handle keeps the child tied to the console,
    // so closing the window could still take the node with it, and its output
    // would keep arriving in a terminal the person has moved on from.
    stdio: ["ignore", logFd, logFd],
  };
}

// Everything the child has written SINCE a byte offset.
//
// Sliced as bytes and then decoded, which is the whole point. `statSync().size`
// is a byte count while `readFileSync(…, "utf8").slice(n)` is a CHARACTER index,
// so the moment the log holds a multi-byte character the two disagree — and this
// log is full of em-dashes. The first symptom was a startup line printed as
// "2: note — …", with six bytes of "hive40" eaten by the drift.
//
// The offset matters at all because the log is opened for APPEND: reading the
// whole file would show a previous run's "watching the room" and report success
// for a child that never started, which is the trap `#bringUpAgent` documents
// for the agent logs (DD-34).
export function tailFrom(readFile, file, byteOffset) {
  try {
    return readFile(file).subarray(byteOffset).toString("utf8");
  } catch {
    // The child may not have written anything yet, so the file may not exist.
    // Silence is a valid state here and `readStartup` handles it.
    return "";
  }
}

// Read the child's output so far and decide what to tell the person.
//
// Three outcomes, and the third is why this is not just a string match:
//
//   started  the marker is there. Report the child's own summary.
//   failed   the child is GONE and never got there. Report what it said, and
//            fail: a start that cannot fail is a start nobody can trust, and
//            `up` refusing for a real reason is something this must not swallow.
//   neither  still coming up. The caller polls; "nothing yet" must not resolve
//            either way, or a slow relay would read as a failure.
export function readStartup({ text = "", exited = false }) {
  const started = text.includes(WATCHING_MARKER);
  return {
    started,
    failed: !started && exited,
    // The Ctrl-C line belongs to whoever is holding the process, and in this
    // mode nobody is. Echoing it back would tell the person to press a key that
    // does nothing in the terminal they are looking at.
    output: text
      .split("\n")
      .filter((line) => !/Ctrl-C/i.test(line))
      .join("\n")
      .trim(),
  };
}
