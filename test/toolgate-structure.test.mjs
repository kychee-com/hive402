// Shell control structure is not itself an action (found by running it, cycle 2).
//
// A delegation attack was refused by spike on its own merits, and then spike
// tried to tell the room so by looping over the room's members:
// `for pk in <a> <b> <c>; do buzz messages send --mention $pk …; done`.
//
// The head of that first segment is `for`, which is not a command anyone has
// heard of, so it scored as build and the reply was refused. Fourth live defect
// in a row in the same place, and the same shape as the others: the classifier
// was reading something that is not a command as if it were one.
//
// `for`, `do`, `if`, `while` do nothing by themselves. What matters is the
// commands inside them, and those are already being split out — they just have
// to be read past the keyword.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyTool } from "../src/runtime/toolgate.mjs";

const classify = (command) =>
  classifyTool({ toolName: "Bash", toolInput: { command }, cwd: "C:/state/work/spike" }).capability;

test("a loop that only sends messages is conversation", () => {
  assert.equal(
    classify(`for pk in aaa bbb ccc; do buzz messages send --channel x --mention $pk --content "hi"; done`),
    "converse",
  );
});

test("a loop that does something is classified by what it does, not by the loop", () => {
  assert.equal(classify(`for f in *; do rm $f; done`), "build");
  assert.equal(classify(`for u in a b; do curl https://$u; done`), "research");
  assert.equal(classify(`while true; do curl https://x; done`), "research");
});

test("a conditional is read past, to the command it guards", () => {
  assert.equal(classify(`if buzz messages get --channel x; then buzz messages send --content hi; fi`), "converse");
  assert.equal(classify(`if test -f a; then git push; fi`), "build");
});

test("an unknown command inside a loop is still unknown", () => {
  assert.equal(classify(`for i in 1 2; do somethingstrange; done`), "build");
});

test("a bare structural keyword contributes nothing rather than reading as a build", () => {
  assert.equal(classify(`buzz messages send --content hi; done`), "converse");
});
