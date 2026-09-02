// The taken-message sentences, and how the product recognises its own
// (F-11: AC-61, AC-64).
//
// Both strings are SPEC TEXT — AC-61 and AC-64 quote them verbatim, so a word
// changed here is a spec change, not a copy edit. They are deliberately never
// mention-shaped: no "@" (a non-member @word blocks the send outright in Buzz
// clients), no address tags (an address would wake the agent on its own
// replay). The agent is referred to by plain name, flattened exactly the way
// the attribution line flattens one, so a hostile display name cannot become
// a second line or a fake marker.
//
// Recognition is anchored on the product's own fixed wording. It matters in
// two directions: a covering node must not post a second notice where one
// stands (AC-61's one-notice rule), and the replay pass must find the
// promises made for its agents. Only the WORDING is checked here — whether
// the AUTHOR is trusted is the caller's question, answered differently by the
// two readers (dedup believes anyone; replay believes known nodes only).

import { HIVE_MARKER, safeDisplayName } from "./attribution.mjs";

// AC-61's exact sentence.
export function awayNotice({ name }) {
  const which = safeDisplayName(name) ?? "that agent";
  return `${HIVE_MARKER} ${which} is not online right now. It will get this message when it comes back.`;
}

// "1 message", not "1 message(s)". The parenthesised plural is the shape of a
// string built by somebody who did not want to think about the reader, and
// every line in this module is read by one (FIX-128).
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// AC-66's two drop reports (FIX-142, F-027).
//
// Returned as SENTENCES, without any prefix, because the same words go to two
// surfaces: the node's console keeps `hive402: ` for the operator at a
// terminal, and the room gets the marker. One sentence, two prefixes, so the
// two can never drift into telling different people different things.
//
// Two of them, never one merged line: the COUNT bound drops the oldest of a
// burst that arrived inside the window and its remedy is the limit, while the
// AGE bound drops what sat past the window entirely and has no limit to raise.
// A merged sentence would be wrong about half its own subject.
//
// AC-66 fixes no wording (unlike AC-61 and AC-64, which quote theirs verbatim),
// so these are ours to word — but they are still room text, so they follow the
// same rules as their siblings above: no "@", no dash used as a pause.
export function backlogDropReports({ dropped = 0, agedOut = 0, limit } = {}) {
  const reports = [];
  if (dropped > 0) {
    reports.push({
      bound: "count",
      count: dropped,
      text:
        `${plural(dropped, "older message")} went unanswered (limit ${limit}). ` +
        `Ask again if they still matter.`,
    });
  }
  if (agedOut > 0) {
    reports.push({
      bound: "age",
      count: agedOut,
      text:
        `${plural(agedOut, "message")} for this node's agents arrived while it was off ` +
        `but sat older than the backlog window, so they were not answered. ` +
        `Ask again if they still matter.`,
    });
  }
  return reports;
}

// The room form of a drop report. Marked as the node's own line, and — like
// every other notice in this module — never mention-shaped.
export function backlogDropNotice(report) {
  return `${HIVE_MARKER} ${report.text}`;
}

// AC-64's exact sentence.
export function overflowNotice({ name, waiting, answered }) {
  const which = safeDisplayName(name) ?? "that agent";
  return (
    `${HIVE_MARKER} ${waiting} more messages were waiting for ${which}. ` +
    `It answered the most recent ${answered}. Ask again if one of the others still matters.`
  );
}

const MARKER = HIVE_MARKER.replace(/[[\]]/g, "\\$&");
const AWAY_RE = new RegExp(
  `^\\s*${MARKER} (.+) is not online right now\\. It will get this message when it comes back\\.\\s*$`,
);

// Is this text the away notice? Anchored to the whole line: the marker alone
// is shared with every other line the node writes (wakes, failure notices,
// refusals), and matching any of those as a promise would replay messages
// nobody promised anything about.
export function isAwayNotice(content) {
  return AWAY_RE.test(String(content ?? ""));
}

// Which agent does a notice name? One message can address two offline agents
// and owe each its own promise, so a standing notice suppresses — and a
// replay collects — only the agent it actually names. Null for anything that
// is not the away notice.
export function awayNoticeName(content) {
  return AWAY_RE.exec(String(content ?? ""))?.[1] ?? null;
}

// The node's own line inside a REPLAYED wake (AC-63, AC-65). Appended after
// the human's words, marked like every line the node writes, so the strip
// rule keeps holding. The answered variant is AC-65's behaviour as Barry
// chose it: visible closure — a brief acknowledgment — never silence and
// never a duplicate full answer.
export function replayNote({ answered = false } = {}) {
  const base =
    `${HIVE_MARKER} This message waited while you were offline. ` +
    `The room may have moved on; read the thread before answering.`;
  if (!answered) return base;
  return (
    `${base} It looks like somebody already answered. If it is settled, ` +
    `acknowledge it briefly and add nothing redundant.`
  );
}

// The node's own line inside a RECOVERED wake (FIX-135, F-023, AC-7).
//
// The node handed this message to the harness and then watched the thread go
// unanswered past the grace window. It cannot tell "the model folded it into
// another turn and covered it there" from "the model dropped it", because
// telling them apart means reading the reply and deciding what it covered —
// the wake path's oldest defect class in this product (F-007, F-013).
//
// So it says what it knows and asks the one party that does know. Same posture
// as the replay note's answered variant, and the same reason: visible closure
// beats both silence and a duplicate full answer.
//
// ── Why there are two of these (FIX-143, F-026) ───────────────────────────
//
// The answer check now covers BOTH routes, and the sentence has to follow the
// route it is describing. "This message was delivered to you directly" is
// simply false for a relayed recovery, and telling an agent something untrue
// about its own history is worse than telling it nothing: the one thing this
// note asks the agent to do is check its own memory of the turn.
export function handoffNote({ route = "direct" } = {}) {
  const how =
    route === "relayed"
      ? `This message was relayed to you earlier and no reply to it appeared, so the room is relaying it again.`
      : `This message was delivered to you directly and no reply to it appeared, so the room is relaying it.`;
  return (
    `${HIVE_MARKER} ${how} If you already answered it while ` +
    `working on something else, say so briefly and add nothing redundant.`
  );
}
