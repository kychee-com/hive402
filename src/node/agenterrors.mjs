// What the AGENT said last, when what it said was a failure (FIX-129).
//
// ── The silence this exists to break ───────────────────────────────────────
//
// Barry asked smith a question and got nothing. Not a refusal, not an error, not
// a "working on it" — nothing. hive402 reported a healthy node the whole time,
// and it was telling the truth: it saw the message, published the wake, spawned
// the harness, and the harness connected, subscribed and set presence online.
//
// Then the model backend refused to log in:
//
//   agent_returned outcome="error"
//   error=Agent reported error (code -32603): Internal error:
//         Failed to authenticate: OAuth session expired and could not be refreshed
//
// That line was sitting in `smith.log` for over an hour. Nothing surfaced it, so
// the room saw a silent agent and the operator saw a green `doctor`.
//
// This is the same failure shape FIX-124 was about, arriving through a different
// door: a question in a room with no answer and no explanation. The node cannot
// answer for the agent, but it can say why the agent did not.
//
// ── Reading somebody else's log ────────────────────────────────────────────
//
// This parses `buzz-acp` output, which is a third party's format and will
// change. So it is deliberately narrow: find the last turn RESULT, report it,
// and never try to interpret beyond that. An unrecognised error is shown as
// written rather than guessed at — a wrong explanation is worse than a raw one.

// Colour codes make the log unreadable to a regex and unreadable on a terminal
// that does not render them. Stripped before anything else looks at it.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

// The harness logs one of these per completed turn. `outcome` is the verdict.
const RETURNED = /agent_returned/;

// Evidence that the agent CAME BACK after a failure, so the failure is history
// rather than a verdict on the agent as it stands.
//
// Three markers, not one, and the extra two are load-bearing. `buzz-acp
// starting` only appears when the whole harness restarts — but the node runs it
// with `BUZZ_ACP_LAZY_POOL=true`, so an idle pool is torn down and brought back
// WITHOUT a restart. A failure before one of those teardowns would have gone on
// reading as live forever, and the room would have been told an agent was broken
// every time somebody asked it something.
//
// Measured on the real log: a successful turn writes `agent initialized` and
// `agent_pool_ready` and NOTHING ELSE. There is no "turn succeeded" line to
// look for — `agent_returned` is written on failure only — so recovery has to be
// inferred from the agent standing up again.
const RECOVERED = /buzz-acp starting|agent_pool_ready|agent initialized/;
const OUTCOME = /outcome=\s*"?([a-z]+)"?/i;
const ERROR_TEXT = /error=(.+?)(?:\s+|\s*$)/;

// Errors worth naming a remedy for. Anything else still gets reported, with its
// own words — the list is for causes where the operator would otherwise have no
// idea what to do, not an attempt to classify everything.
const REMEDIES = [
  {
    match: /OAuth session expired|Failed to authenticate|401|unauthoriz/i,
    say: (agent) =>
      `${agent}'s model login has expired. Run "claude" to sign in again, then "hive402 down" and "hive402 up".`,
  },
  {
    match: /rate.?limit|quota|429/i,
    say: (agent) => `${agent} hit a model rate limit. It will work again once the limit resets.`,
  },
  {
    match: /ENOENT|not recognized|cannot find/i,
    say: (agent) => `${agent}'s model command could not be run. Check tools.adapter in your config.`,
  },
];

// The agent's LAST turn, or null if it has never completed one.
//
// Only the last one matters. An error from three days ago that has been followed
// by a working turn is history, and reporting it would train the operator to
// ignore this line — which is how a real failure gets missed.
export function lastAgentTurn(logText = "") {
  const clean = String(logText).replace(ANSI, "");
  const lines = clean.split("\n");
  const index = lines.map((l, i) => (RETURNED.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (index === undefined) return null;
  const line = lines[index];

  const outcome = OUTCOME.exec(line)?.[1]?.toLowerCase() ?? "unknown";
  const at = /^(\S+Z)/.exec(line.trim())?.[1] ?? null;
  // Capped. This is a third party's error string and it goes on one line of a
  // report somebody has to read.
  const message = (ERROR_TEXT.exec(line)?.[1] ?? "").trim().slice(0, 300) || null;

  // HAS THE HARNESS RESTARTED SINCE? Caught immediately after shipping the first
  // cut, on the machine it was written for: Barry fixed his login, the node
  // restarted, smith came up healthy — and `doctor` still said "it will not
  // answer until this is fixed", because the newest turn RESULT in the log was
  // still the old failure. It had not failed again; it had not been asked.
  //
  // Worse, the room notice would have fired on his next message, telling him an
  // agent that was working could not answer. A false alarm is not a smaller
  // version of a true one — it teaches the reader to ignore the next real one,
  // which is exactly what these two fixes exist to prevent.
  const restarted = lines.slice(index + 1).some((l) => RECOVERED.test(l));
  return { outcome, failed: outcome !== "ok", at, message, restarted };
}

// What to TELL the operator about that turn, or null when there is nothing worth
// saying. A successful last turn is not news.
export function describeAgentFailure({ agent, turn }) {
  if (!turn?.failed) return null;
  // Restarted since: the failure is history, not a verdict on the agent as it
  // stands. `doctor` still mentions it (see `stale`), but nothing tells the room
  // an agent cannot answer when it has simply not been asked yet.
  if (turn.restarted) return null;
  const remedy = REMEDIES.find((r) => r.match.test(turn.message ?? ""))?.say(agent) ?? null;
  return {
    headline: `${agent}'s last turn FAILED${turn.at ? ` (${turn.at})` : ""} — it will not answer until this is fixed`,
    // The agent's own words when nothing here recognises them. A guess would be
    // worse: this parses somebody else's log format and cannot be sure.
    detail: remedy ?? turn.message ?? "the harness reported no reason",
  };
}

// What `doctor` says about a failure the agent has RESTARTED since.
//
// Not silence, because the last thing that actually happened is still worth
// knowing when an agent is misbehaving. Not a FAIL either, because it is not one
// yet: the agent has not been asked since it came back, so nothing is currently
// wrong that anybody can act on.
export function describeStaleFailure({ agent, turn }) {
  if (!turn?.failed || !turn.restarted) return null;
  return `${agent}'s last turn failed${turn.at ? ` (${turn.at})` : ""}, but it has restarted since and has not been asked yet.`;
}
