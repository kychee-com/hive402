// Which channels is this agent actually in? (AC-48, DD-48, FIX-120.)
//
// ── The second list ────────────────────────────────────────────────────────
//
// Until now a config file said which channels the node watched, per room. That
// list is invisible to the room itself, and it can disagree with the relay in
// both directions:
//
//   • an agent added to a channel in Buzz Desktop stays deaf there until
//     somebody edits a JSON file on the node's machine and restarts it;
//   • an agent REMOVED from a channel keeps being launched with it, so the
//     owner's action in their own client did not do what it looked like.
//
// AC-48 removes the second list: "Channel membership, which every member can
// already see and change in their client, IS the per-channel permission
// surface." Adding an agent to a channel in any Buzz client is sufficient to
// make that channel live for it, and removing it there stops it.
//
// ── The primitive ─────────────────────────────────────────────────────────
//
// `buzz channels list --member` — "Only show channels where the current
// identity is a member" (ChannelsCmd at buzz `origin/main` 29f2054c). Run as
// the AGENT, because it is the agent's memberships that decide where the agent
// belongs, not the node's.
//
// ── Failure is not emptiness ──────────────────────────────────────────────
//
// A relay that cannot be read must never render as "this agent is in no
// channels". That would take a working room down on a network blip and call it
// configuration. So an error is reported AS an error and the caller keeps what
// it had.

const channelIdOf = (row) =>
  row?.channel ?? row?.channel_id ?? row?.channelId ?? row?.id ?? row?.uuid ?? null;

export async function channelsForAgent({ cli }) {
  const rows = await cli.myChannels();
  const ids = [];
  const seen = new Set();
  for (const row of rows ?? []) {
    const id = String(channelIdOf(row) ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// What changed between two membership readings. Returned as sets rather than a
// boolean because the supervisor has to act differently on each half: a joined
// channel needs the agent launched into it, a left channel needs it stopped.
export function membershipDelta(before, after) {
  const had = new Set(before ?? []);
  const has = new Set(after ?? []);
  return {
    joined: [...has].filter((c) => !had.has(c)),
    left: [...had].filter((c) => !has.has(c)),
    changed: [...has].some((c) => !had.has(c)) || [...had].some((c) => !has.has(c)),
  };
}

// Read every agent's memberships, tolerating a per-agent failure.
//
// One agent's relay error must not decide the whole node's watch set: the
// others' readings are still good, and dropping them would turn one agent's
// problem into everyone's silence.
export async function readMemberships({ agents, cliFor }) {
  const memberships = new Map();
  const failures = [];
  for (const agent of agents) {
    try {
      memberships.set(agent.name, await channelsForAgent({ cli: cliFor(agent) }));
    } catch (err) {
      failures.push({ agent: agent.name, reason: err.message });
    }
  }
  return { memberships, failures };
}
