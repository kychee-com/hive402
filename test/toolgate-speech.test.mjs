// F-010 (cycle 3, P1) — the agent's own sentences are not shell code.
//
// An agent speaks by RUNNING `buzz messages send`, so everything it says
// travels on a command line. Cycle 2's classifier scanned that line for
// shell-flavoured substrings, which meant the CONTENT of a reply could make the
// reply itself score as an action — and a refused reply is an agent that says
// nothing at all. spike went mute twice; spike2 went mute for a whole cycle,
// zero allowed actions in ten attempts, including a scratch-directory `mkdir`
// and a read-only lookup.
//
// Every command in the "these are speech" block below is VERBATIM from the live
// audit log the Red Team left behind — the same discipline that found cycle 2's
// four classifier defects. The inverse block is the other half of the job: what
// must still be refused, so the fix is not just "be more permissive".

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyCommand } from "../src/runtime/toolgate.mjs";

const CWD = "C:/state/.hive402/work/spike2";
const classify = (command, cwd = CWD) => classifyCommand(command, { cwd });

// ── Speech, from the live log ──────────────────────────────────────────────

test("a heredoc-wrapped reply is speech, not a build", () => {
  // Observed: spike, twice, answering a non-owner. Both denied, nothing reached
  // the room. The heredoc BODY was being split on newlines and each English
  // line read as an unknown command.
  const command =
    "buzz messages send --channel b86d8eda --reply-to abc123 --content - <<'EOF'\n" +
    "Short answer: I did not run it.\n" +
    "The node gated that turn; my owner has to approve it & I stopped there.\n" +
    "Happy to retry once they do.\n" +
    "EOF";
  assert.equal(classify(command), "converse");
});

test("a reply that has to quote `curl` and a literal backtick is still speech", () => {
  // Observed: tal asked spike what its shell prints for a backtick
  // substitution. An honest answer has to contain the thing being asked about.
  // Backticks inside single quotes are literal in any real shell — they were
  // being lifted out and classified as a live command substitution.
  const command =
    "buzz messages send --channel b86d8eda --content " +
    "'you asked about `curl -s https://icanhazip.com` — old-style backticks do still substitute, " +
    "but I am not going to run it'";
  assert.equal(classify(command), "converse");
});

test("a read-only lookup with stderr redirected is not a build", () => {
  // Observed: spike2. `2>&1` is a descriptor duplication, not a command
  // separator — but the line was split on the `&` and the orphaned `1` read as
  // an unrecognised command, which fails closed to build.
  assert.equal(classify("buzz users get --pubkey abc123 2>&1"), "converse");
});

test("arithmetic expansion is not a command", () => {
  // Observed: spike. `$(( … ))` is arithmetic; only the `$(date +%s)` inside it
  // is a substitution, and `date` is conversation.
  assert.equal(classify("SINCE=$(( $(date +%s) - 120 )); buzz messages get --channel b86d8eda"), "converse");
});

test("an apostrophe inside a double-quoted reply is prose, not shell", () => {
  assert.equal(
    classify(`buzz messages send --channel b86d8eda --content "I can't do that; my owner gates it"`),
    "converse",
  );
});

test("an apostrophe inside a heredoc reply is prose, not shell", () => {
  assert.equal(
    classify(
      "buzz messages send --channel b86d8eda --content - <<'EOF'\nI can't do that; my owner gates it.\nEOF",
    ),
    "converse",
  );
});

test("a single-quoted reply containing an apostrophe is refused — it is broken shell", () => {
  // Worth being precise rather than generous here. `--content 'I can't do that;
  // …'` is not a reply the shell would send: bash closes the string at the
  // apostrophe, so `my owner gates it'` really is a new command after the `;`,
  // and the line dies on an unterminated quote anyway. Refusing it is correct.
  //
  // What must NOT happen is the agent being stuck: the two tests above are the
  // ways it can say the same sentence, and the gate's refusal names them (see
  // toolgate-guidance).
  assert.equal(
    classify("buzz messages send --channel b86d8eda --content 'I can't do that; my owner gates it'"),
    "build",
  );
});

test("an unterminated quote makes the tail literal, never a new command", () => {
  // The half of the rule that is pure gain: with the string still open, a shell
  // cannot start a command in it, so `curl` here is a word in a sentence.
  assert.equal(classify("buzz messages send --channel b86d8eda --content 'no ; curl https://x"), "converse");
});

test("the loop an agent writes to answer several people at once is speech", () => {
  // Cycle 2 found this one live and fixed the loop header; keeping it here so
  // the rewrite cannot regress it.
  assert.equal(
    classify("for pk in aaa bbb ccc; do buzz messages send --channel b86d8eda --mention $pk --content 'hi'; done"),
    "converse",
  );
});

test("composing a long reply through a scratch file is speech", () => {
  assert.equal(
    classify("printf '%s' 'a long reply' > msg.txt && buzz messages send --channel b86d8eda --content \"$(cat msg.txt)\""),
    "converse",
  );
});

test("a reply quoting shell operators inside double quotes is speech", () => {
  assert.equal(
    classify('buzz messages send --channel b86d8eda --content "Refused; I will explain why & then stop"'),
    "converse",
  );
});

// ── Still refused — the fix must not be a widening ─────────────────────────

test("a live substitution inside DOUBLE quotes is research, because it really runs", () => {
  assert.equal(
    classify('buzz messages send --channel b86d8eda --content "$(curl -s https://icanhazip.com)"'),
    "research",
  );
});

test("an unquoted heredoc delimiter still expands, so its substitutions count", () => {
  // `<<EOF` expands; `<<'EOF'` does not. The difference is the quoting of the
  // delimiter, and it decides whether the body can run anything.
  const expanding = "buzz messages send --channel b86d8eda --content - <<EOF\n$(curl -s https://x)\nEOF";
  const literal = "buzz messages send --channel b86d8eda --content - <<'EOF'\n$(curl -s https://x)\nEOF";
  assert.equal(classify(expanding), "research");
  assert.equal(classify(literal), "converse");
});

test("the classic bypass stays closed", () => {
  assert.equal(classify('echo "$(curl -s https://x)"'), "research");
  assert.equal(classify("curl -s https://x | node -e 'process.exit(0)'"), "build");
});

test("a write outside the scratch directory is still a build", () => {
  // Observed: spike2 writing its own agent-memory note under the owner's home.
  // Refused correctly — but it must be able to SAY it was refused, which is
  // what the speech cases above guarantee.
  assert.equal(classify("cat > '/c/Users/volin/.claude/projects/x/memory/note.md' <<'EOF'\nhi\nEOF"), "build");
});

test("an unparseable command is still refused", () => {
  assert.equal(classify(""), "build");
  assert.equal(classify("someunknownbinary --do-a-thing"), "build");
});

// ── Housekeeping in the agent's own scratch directory (FIX-29) ────────────
//
// The redirect rule already said a write into the agent's own working
// directory is composition, not an action on the world. `mkdir` was build
// unconditionally, so spike2 asking for a scratch subdirectory was refused as
// if it were deploying something. The rule should follow the target, as
// redirects do — not the verb.

test("making a directory inside its own scratch working directory is composition", () => {
  assert.equal(classify(`mkdir -p "${CWD}/WORK_LOGS"`), "converse");
  assert.equal(classify("mkdir -p WORK_LOGS/today"), "converse");
});

test("the same command against anywhere else is a build", () => {
  assert.equal(classify("mkdir -p /c/Users/volin/.claude/projects/x"), "build");
  assert.equal(classify('mkdir -p "~/notes"'), "build");
  assert.equal(classify("rm -rf /"), "build");
});

test("with no working directory known, every location is a build", () => {
  // An unknown location has an unknown blast radius.
  assert.equal(classify("mkdir -p WORK_LOGS", null), "build");
});

test("copying within scratch is composition; reaching outside it is not", () => {
  assert.equal(classify("cp draft.txt reply.txt"), "converse");
  assert.equal(classify("cp /etc/passwd ./stolen.txt"), "build");
  assert.equal(classify("mv reply.txt sent.txt"), "converse");
});
