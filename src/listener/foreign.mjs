// Who else's agents live in this room, and whose node answers for each
// (F-11, DD-53).
//
// The managed-agent record (kind 30177) is world-readable, keyed
// `d = <agent pubkey>`, and authored by the agent's attesting owner — which
// for a hive402 agent is its HOSTING NODE (DD-51). That author is the whole
// point here: F-11's "offline" is a claim about the owner-node, so everything
// the cover path decides is keyed on the record's author, never on the agent
// process (agents idle out by design, AC-41/42, and calling a napping agent
// "not online" is exactly what AC-62 forbids).
//
// Nothing here re-verifies NIP-OA. The consequence is deliberately
// conservative: when two authors both claim the same agent, this module
// returns NEITHER — a notice keyed on the wrong owner's presence would
// promise an answer the real owner never sees, and no notice beats a wrong
// one. The same posture as upstream's picker, reached from the opposite side:
// Desktop drops the unverified record, we drop the contested agent.

import { resolveAddressed } from "./mentions.mjs";
import { KIND_MANAGED_AGENT } from "../identity/managedagent.mjs";

const KIND_MESSAGE = 9;
const PUBKEY_RE = /^[0-9a-fA-F]{64}$/;

const lc = (value) => String(value ?? "").toLowerCase();

// Parse `/query` rows of kind 30177 into `{ pubkey, name, node }` — the agent,
// its display name (what "@name" resolves against), and the author whose
// presence decides "offline". Malformed rows are dropped silently: a record no
// Buzz client would trust is not a reason to speak in a room.
export function managedAgentsFrom(rows) {
  // Newest per (author, agent) coordinate first — the relay stores only the
  // latest per replaceable coordinate, but this code must not depend on every
  // relay honouring that.
  const byCoordinate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== KIND_MANAGED_AGENT) continue;
    const d = (Array.isArray(row.tags) ? row.tags : []).find(
      (t) => Array.isArray(t) && t[0] === "d",
    )?.[1];
    if (typeof d !== "string" || !PUBKEY_RE.test(d)) continue;
    if (typeof row.pubkey !== "string" || !PUBKEY_RE.test(row.pubkey)) continue;
    let name = null;
    try {
      name = JSON.parse(row.content)?.name ?? null;
    } catch {
      continue;
    }
    if (typeof name !== "string" || name === "") continue;

    const agent = lc(d);
    const node = lc(row.pubkey);
    const key = `${node}:${agent}`;
    const seen = byCoordinate.get(key);
    if (seen && (seen.created_at ?? 0) >= (row.created_at ?? 0)) continue;
    byCoordinate.set(key, { agent, node, name, created_at: row.created_at ?? 0 });
  }

  // Contested agents — two AUTHORS claiming one agent pubkey — are removed
  // whole. See the module header for why neither claim survives.
  const byAgent = new Map();
  for (const entry of byCoordinate.values()) {
    if (!byAgent.has(entry.agent)) byAgent.set(entry.agent, []);
    byAgent.get(entry.agent).push(entry);
  }
  const out = [];
  for (const claims of byAgent.values()) {
    if (claims.length !== 1) continue;
    const { agent, name, node } = claims[0];
    out.push({ pubkey: agent, name, node });
  }
  return out;
}

// The agents the COVER path is responsible for in one channel: registered,
// actually a member there, and hosted by somebody else. Our own agents are
// excluded twice over — by pubkey and by author — because covering for an
// agent this node hosts is nonsense: if this code is running, that agent's
// node is online by definition.
export function foreignAgentsIn({ records, members, ownAgentPubkeys = [], selfNode = null }) {
  const member = new Set([...members].map(lc));
  const own = new Set([...ownAgentPubkeys].map(lc));
  const self = lc(selfNode);
  return records.filter(
    (r) => member.has(r.pubkey) && !own.has(r.pubkey) && (self === "" || r.node !== self),
  );
}

// Which foreign agents does this message address? Both spellings — "@name" in
// the body and the client-held mention tag — through the SAME resolver the
// dispatcher wakes with (`resolveAddressed`), so "addressed" cannot mean two
// different things on the live path and the cover path.
export function foreignMentions({ event, foreign }) {
  if (event?.kind !== KIND_MESSAGE) return [];
  const addressed = new Set(
    resolveAddressed({ content: event.content, tags: event.tags, agents: foreign }).map(lc),
  );
  return foreign.filter((f) => addressed.has(f.pubkey));
}
