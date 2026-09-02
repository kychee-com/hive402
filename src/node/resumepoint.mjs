// Where this node got to, per channel (FIX-124).
//
// The one fact `partitionOnResume` needs and the process cannot hold: the
// `created_at` of the newest event this node has already handled in a channel.
//
// Written while the node is ALIVE, on every tick, rather than at shutdown. The
// case FIX-124 exists for is a machine being switched off, and that is exactly
// the case where no shutdown code runs at all — so a record written at `stop()`
// would be missing precisely when it is needed. A record written as the node
// works survives a crash, a power cut and a closed lid identically.
//
// One small JSON file for the whole node rather than one per channel: the write
// happens on every tick of every room, and a directory of files would turn that
// into a directory scan. It is read once per room at start.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = "resume.json";

const pathFor = (stateDir) => path.join(stateDir, FILE);

function readAll(stateDir) {
  const file = pathFor(stateDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt file reads as "no resume point", which means "treat the room as
    // history" — one silent gap rather than a room-wide replay. The failure
    // direction matters more than the failure.
    return {};
  }
}

// A channel's record, in either shape. It used to be a bare number; FIX-132
// needs a second field beside it, and an install written by the older code must
// keep working rather than losing its place and replaying a room.
function entryFor(all, channel) {
  const raw = all[channel];
  if (Number.isFinite(raw)) return { at: raw, heldFor: null };
  if (raw && typeof raw === "object") {
    return { at: Number.isFinite(raw.at) ? raw.at : null, heldFor: raw.heldFor ?? null };
  }
  return { at: null, heldFor: null };
}

// Unix SECONDS of the newest event handled in this channel, or null.
export function readResumePoint({ stateDir, channel }) {
  return entryFor(readAll(stateDir), channel).at;
}

// Advance the point. NEVER retreats: events do not arrive in timestamp order,
// and a late-delivered old one rewinding the mark would re-open a window the
// node has already closed, re-answering what it answered on the previous tick.
export function writeResumePoint({ stateDir, channel, at }) {
  if (!Number.isFinite(at)) return;
  const all = readAll(stateDir);
  const entry = entryFor(all, channel);
  if (entry.at !== null && at <= entry.at) return;
  all[channel] = { at: Math.floor(at), heldFor: entry.heldFor };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pathFor(stateDir), `${JSON.stringify(all, null, 2)}\n`);
}

// ── Holding the point back for ONE retry (FIX-132) ─────────────────────────
//
// The resume point means "I have SEEN up to here", and that is not the same as
// "the agent ANSWERED up to here". Barry asked smith twice while its model
// backend was refusing to log in: the node saw both, relayed both, and advanced
// past both. The turns failed one layer down, the node had no idea, and the
// questions were left permanently unanswered with nothing to ever retry them.
//
// So while an agent has a LIVE failure, the point is not advanced — and the
// messages after it become backlog on the next start, retried through the caps
// FIX-124 already enforces.
//
// `heldFor` is what bounds it to ONE retry. It records the failure timestamp the
// hold was made for, so a second hold for the same failure never happens: a
// persistently broken agent re-attempts its questions once and then the room
// moves on. Without it, every restart would re-ask everything of an agent that
// is going to fail again, burning turns and model spend to no purpose — which is
// the objection that made this a decision rather than a bug fix.
export function readHeldFor({ stateDir, channel }) {
  return entryFor(readAll(stateDir), channel).heldFor;
}

export function writeHeldFor({ stateDir, channel, failureAt }) {
  const all = readAll(stateDir);
  const entry = entryFor(all, channel);
  all[channel] = { at: entry.at, heldFor: failureAt ?? null };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(pathFor(stateDir), `${JSON.stringify(all, null, 2)}\n`);
}
