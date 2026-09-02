// Showing a community's join policy and asking a person to accept it (AC-45).
//
// ── Why this is its own module, and imports nothing from credentials/ ──────
//
// AC-43 says hive402 never asks a human for their Nostr secret key — not at
// setup, not to join, not ever. That is a property of the PATH, so a test walks
// the join command's import graph and fails if `credentials/prompt.mjs` (the
// masked secret reader) is reachable from it. Keeping the line reader here,
// small and local, is what lets that test mean something: the join path
// physically cannot reach the code that reads a secret.
//
// ── Why the acceptance is typed, and echoed ───────────────────────────────
//
// A keypress is not what AC-45 describes. The person types words, sees the
// words they typed, and anything else is a stop — including an empty line, a
// timeout, or a stray "y" from muscle memory. And a missing acceptance is a
// stop, never a default: nothing about this function can return `accepted:
// true` unless someone typed the word.
//
// The terms run to roughly 75k characters on the Kychee community, so the
// default is a summary plus the relay's own browser-readable copies (DD-47).
// `--show-terms` prints the whole thing for someone who wants it in the
// terminal.

const ACCEPT_WORD = "accept";
const CONFIRM_WORD = "yes";

// Visible lines. Deliberately NOT `readSecret` — masking the one moment a
// person is meant to be deliberate about makes it feel like a password, and
// they could not see that they had mistyped the word being waited for.
//
// FOUND BY WRITING THE TEST (2026-08-25): this must be a reader that OWNS the
// stream, not a function called twice. This flow asks two questions — accept
// the terms, then confirm the age statement — and a per-call reader hands the
// rest of the chunk it read to the garbage collector. One paste, one piped
// heredoc, or a terminal that delivers both lines together, and the answer to
// question two has already been consumed and discarded by question one. The
// command then waits forever, at the exact moment a person is trying to join.
//
// So: one buffer, spanning every question, and lines are handed out from it.
export function lineReader({ input = process.stdin, output = process.stdout } = {}) {
  let buffer = "";
  let ended = false;
  const waiting = [];

  const pump = () => {
    while (waiting.length > 0) {
      const at = buffer.search(/\r\n|\r|\n/);
      if (at === -1) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + (buffer.startsWith("\r\n", at) ? 2 : 1));
      waiting.shift()(line);
    }
    // A closed stdin is not an acceptance. Every outstanding question is
    // answered with whatever was typed — usually nothing — which the caller
    // reads as a refusal.
    while (ended && waiting.length > 0) {
      const rest = buffer;
      buffer = "";
      waiting.shift()(rest);
    }
  };

  if (input.setEncoding) input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += String(chunk);
    pump();
  });
  input.on("end", () => {
    ended = true;
    pump();
  });
  input.resume();

  return {
    ask(prompt) {
      output.write(prompt);
      return new Promise((resolve) => {
        waiting.push(resolve);
        pump();
      });
    },
    close() {
      input.pause();
    },
  };
}

const rule = (output) => output.write(`${"─".repeat(66)}\n`);

// The first ~40 lines of a policy document, which is the part that says what
// the community is. The rest is available in a browser and behind --show-terms.
// FOUND BY RUNNING IT AGAINST REAL TERMS (2026-08-26): counting LINES is not
// counting length. A line cap of 40 is fine for a document with short lines and
// useless for the Buzz Terms of Service, where each paragraph is a single line
// of several hundred characters — 40 of those is roughly twenty thousand
// characters of dense legalese, which is not a summary, it is the whole thing
// with the end cut off. DD-47 asked for "a summary + full-text-on-request
// rather than paging the whole thing by default", and this was paging it.
//
// So both: at most `lines` lines AND at most `chars` characters, whichever
// runs out first, and the cut lands on a word boundary rather than mid-word.
function summarise(markdown, { lines = 40, chars = 1400 } = {}) {
  const all = String(markdown ?? "").split(/\r?\n/);
  const kept = [];
  let used = 0;
  for (const line of all.slice(0, lines)) {
    if (used + line.length > chars) {
      const room = chars - used;
      if (room > 80) {
        const cut = line.slice(0, room);
        kept.push(`${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : room)}…`);
      }
      return { text: kept.join("\n"), truncated: true };
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { text: kept.join("\n"), truncated: kept.length < all.length };
}

export function terminalConsent({
  input = process.stdin,
  output = process.stdout,
  showTerms = false,
  // The caller may pass a reader it also uses for its OWN questions — the join
  // asks for a display name straight after this (AC-46). Two readers on one
  // stdin is the same bug one reader per question was: whichever consumed the
  // chunk keeps what the other was waiting for.
  reader: shared = null,
} = {}) {
  // Created lazily so constructing the consent function does not put stdin into
  // flowing mode for a community that turns out to have no policy at all.
  let reader = shared;
  const ask = (prompt) => {
    reader ??= lineReader({ input, output });
    return reader.ask(prompt);
  };
  // A reader we were handed belongs to the caller, who is still using it.
  const closeIfOurs = () => {
    if (!shared) reader?.close();
  };

  return async (policy) => {
    rule(output);
    output.write(`This community asks you to accept its terms before joining.\n`);
    output.write(`Policy version: ${policy.version}\n\n`);

    for (const [label, body, url] of [
      ["TERMS", policy.terms, policy.termsUrl],
      ["PRIVACY", policy.privacy, policy.privacyUrl],
    ]) {
      if (!body) continue;
      output.write(`── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}\n`);
      const { text, truncated } = showTerms ? { text: body, truncated: false } : summarise(body);
      output.write(`${text}\n`);
      if (truncated) output.write(`\n  … shortened. Full text: ${url}\n  (or re-run with --show-terms)\n`);
      else output.write(`\n  Also readable at: ${url}\n`);
      output.write("\n");
    }

    rule(output);
    const typed = (await ask(`Type "${ACCEPT_WORD}" to accept this policy, or anything else to stop: `))
      .trim()
      .toLowerCase();

    if (typed !== ACCEPT_WORD) {
      output.write("Not accepted. Nothing was sent.\n");
      closeIfOurs();
      return { accepted: false, ageConfirmed: false };
    }

    if (!policy.ageAttestationRequired) {
      closeIfOurs();
      return { accepted: true, ageConfirmed: false };
    }

    // A separate question, because it is a separate statement. hive402 does not
    // make it on anyone's behalf, so it cannot be folded into the first answer.
    const age = (
      await ask(
        `This community also requires a minimum-age attestation. Type "${CONFIRM_WORD}" to confirm you meet it: `,
      )
    )
      .trim()
      .toLowerCase();
    closeIfOurs();

    if (age !== CONFIRM_WORD) {
      output.write("Age attestation not given. Nothing was sent.\n");
      return { accepted: false, ageConfirmed: false };
    }
    return { accepted: true, ageConfirmed: true };
  };
}
