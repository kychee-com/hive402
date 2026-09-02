// The promises made for OUR agents while this node was off (F-11: AC-63,
// AC-64, AC-65 — the pure half, plus the dispatched-marks file).
//
// A promise is a taken-message notice — the fixed AC-61 sentence — authored
// by a TRUSTED identity: one of the registry's attesting nodes, or this node
// itself. Trust matters here in a way it does not for dedup: anyone can type
// the sentence, and a forged "promise" would otherwise let any member
// resurrect an arbitrary old mention of our agents on our next start. A
// forged notice still suppresses a peer's real one (dedup believes anyone,
// deliberately — the room WAS told something), and the cost of that is a
// message that falls back to the ordinary catch-up window rather than a
// promise kept; the cost of trusting it here would be replay-by-forgery.
//
// Replay is bounded by COUNT, never by age (AC-64): the room was told the
// message was taken, and a promise does not expire. The cap keeps the NEWEST
// — the ones somebody may still be waiting on — and what it drops is named
// in the room, never swallowed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { awayNoticeName, isAwayNotice } from "../listener/notices.mjs";
import { replyTargetOf } from "../listener/threads.mjs";
import { resolveAddressed } from "../listener/mentions.mjs";

const lc = (value) => String(value ?? "").toLowerCase();

// Which (message, agent) promises stand in these events for OUR agents?
export function promisesIn({ events, agents, trustedAuthors }) {
  const trusted = new Set([...trustedAuthors].map(lc));
  const byKey = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.kind !== 9) continue;
    if (!isAwayNotice(event.content)) continue;
    if (!trusted.has(lc(event.pubkey))) continue;
    const target = replyTargetOf(event);
    if (!target) continue;
    const name = lc(awayNoticeName(event.content));
    const agent = agents.find((a) => lc(a.name) === name);
    if (!agent) continue;
    const key = `${lc(target)}:${lc(agent.pubkey)}`;
    if (!byKey.has(key)) byKey.set(key, { id: lc(target), agent, noticedAt: event.created_at ?? 0 });
  }
  return [...byKey.values()];
}

// Does the promised message actually address the promised agent? A notice
// pointing at a message that never asked is a mistake or a forgery, and
// replaying its target would wake an agent nobody addressed.
export function addressesAgent({ event, agent }) {
  return (
    resolveAddressed({ content: event?.content, tags: event?.tags, agents: [agent] }).length > 0
  );
}

// What does the thread already hold, after the promised message?
// - the AGENT's own reply → the promise is complete, nothing to replay;
// - a human's reply → replay still happens, with the acknowledge-briefly
//   instruction (AC-65 — Barry chose visible closure over silence);
// - machine lines (nodes' notices and wakes, other agents) → neither.
export function threadVerdict({ replies, agentPubkey, machineAuthors, afterSec = 0 }) {
  const machine = new Set([...machineAuthors].map(lc));
  let answeredByAgent = false;
  let answeredByHuman = false;
  for (const reply of Array.isArray(replies) ? replies : []) {
    if (reply?.kind !== 9) continue;
    if ((reply.created_at ?? 0) <= afterSec) continue;
    const author = lc(reply.pubkey);
    if (author === lc(agentPubkey)) answeredByAgent = true;
    else if (!machine.has(author) && !isAwayNotice(reply.content)) answeredByHuman = true;
  }
  return { answeredByAgent, answeredByHuman };
}

// Bound the replay by count, never silently: keep the NEWEST `cap` per agent
// (the ones somebody may still be waiting on), replay them oldest-first so a
// conversation replays in the order it was said, and report per-agent how
// many older promises were dropped so the room can be told (AC-64).
export function capPromises({ promises, cap }) {
  const byAgent = new Map();
  for (const promise of promises) {
    const key = promise.agent.name;
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(promise);
  }

  const kept = [];
  const dropped = new Map();
  for (const [name, list] of byAgent) {
    list.sort((a, b) => (a.original.created_at ?? 0) - (b.original.created_at ?? 0));
    const over = Math.max(0, list.length - cap);
    if (over > 0) dropped.set(name, over);
    kept.push(...list.slice(over));
  }
  kept.sort((a, b) => (a.original.created_at ?? 0) - (b.original.created_at ?? 0));
  return { kept, dropped };
}

// ── The dispatched marks (`promises.json`) ─────────────────────────────────
//
// One replay per promise, ever — the same posture as the resume point
// (FIX-124) and the one-retry hold (FIX-132): a node that restarts twice in a
// night must not answer the same promised message twice. Written like
// `resume.json`: a small JSON file, corrupt reads as empty, and old marks are
// pruned on write so the file cannot grow without bound. The horizon is
// generous — a mark only needs to outlive the notice search that would
// re-find its promise.

const FILE = "promises.json";
const MARK_HORIZON_SEC = 30 * 24 * 60 * 60;

const markPath = (stateDir) => path.join(stateDir, FILE);

function readMarks(stateDir) {
  const file = markPath(stateDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Corrupt reads as "nothing dispatched" — the failure direction is a
    // repeated answer, bounded by the cap, rather than a silently kept one.
    return {};
  }
}

const markKey = (id, agent) => `${lc(id)}:${lc(agent)}`;

export function isDispatched({ stateDir, id, agent }) {
  return Object.prototype.hasOwnProperty.call(readMarks(stateDir), markKey(id, agent));
}

export function markDispatched({ stateDir, id, agent, at }) {
  const marks = readMarks(stateDir);
  marks[markKey(id, agent)] = Math.floor(at);
  for (const [key, stamped] of Object.entries(marks)) {
    if (!Number.isFinite(stamped) || at - stamped > MARK_HORIZON_SEC) delete marks[key];
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(markPath(stateDir), `${JSON.stringify(marks, null, 2)}\n`);
}
