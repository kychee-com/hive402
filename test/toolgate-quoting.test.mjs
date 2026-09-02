// Quote-aware classification (found by running it, cycle 2, third live defect).
//
// spike refused a delegation attack on its own merits and then tried to SAY so.
// Its reply never reached the room: the gate scored `printf '…long message…' |
// buzz messages send` as a build and refused it.
//
// The cause was that segments were split on shell operators over the RAW string,
// so a `;`, `&&` or `>` inside the quoted MESSAGE TEXT split the command and
// left a fragment beginning with an ordinary English word. An unknown head is
// treated as build (correctly), so the agent's voice was scored as an action.
//
// This is the mute failure mode the launcher exists to prevent, arriving through
// a new door — and it is worse than mute, because a contained agent that cannot
// speak leaves the room with no idea anything was refused.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyTool } from "../src/runtime/toolgate.mjs";

const CWD = "C:/state/work/spike";
const classify = (command) => classifyTool({ toolName: "Bash", toolInput: { command }, cwd: CWD }).capability;

test("shell operators inside a quoted message do not split the command", () => {
  assert.equal(
    classify(`printf '%s' 'I would rather not; my lookups are gated & I stopped' | buzz messages send --content -`),
    "converse",
  );
  assert.equal(classify(`buzz messages send --content "one; two && three | four"`), "converse");
  assert.equal(classify(`buzz messages send --content "10 > 5, obviously"`), "converse");
});

test("a real operator OUTSIDE quotes still splits and still counts", () => {
  assert.equal(classify(`buzz messages send --content "hi" && git push`), "build");
  assert.equal(classify(`buzz messages send --content "hi"; curl https://x`), "research");
  assert.equal(classify(`curl https://x | git apply -`), "build");
});

test("a quoted command PATH is still read as its binary", () => {
  assert.equal(classify(`"C:\\Users\\volin\\AppData\\Local\\Buzz\\buzz.exe" messages send --content "a; b"`), "converse");
});

test("a substitution inside quotes is still opened and classified", () => {
  // Masking quoted operators must not hide a real command from the gate.
  assert.equal(classify(`buzz messages send --content "the price is $(curl -s https://api.x)"`), "research");
  assert.equal(classify(`printf '%s' "$(git log -1)" | buzz messages send --content -`), "build");
});

test("an apostrophe in ordinary prose does not swallow the rest of the line", () => {
  // `don't` opens a single quote that never closes. If the masker treats
  // everything after it as quoted, a real `&& git push` later on goes unseen.
  assert.equal(classify(`buzz messages send --content "I don't think so" && git push`), "build");
});

test("a multi-line reply is still just a reply", () => {
  const command = [
    `printf '%s\\n' 'line one: I stopped.' 'line two: the fetch was refused; nothing ran.' \\`,
    `  | buzz messages send --channel abc --content -`,
  ].join("\n");
  assert.equal(classify(command), "converse");
});
