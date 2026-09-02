// Capability grants — the node's per-turn statement of what an agent may do.
//
// This is the record at the centre of DD-15. Cycle 2's F-007 showed why it has
// to exist: capability was a property of the agent PROCESS (a settings file
// written once at launch), while authority was a property of the MESSAGE (a
// verb lexicon reading text). A non-owner only had to phrase a request without
// the lexicon's verbs and a fully capable process answered them.
//
// So capability becomes a property of the TURN. The node writes one record per
// agent saying what this turn may do; the tool gate (toolgate.mjs), running
// inside the agent's runtime immediately before any tool executes, reads it.
//
// Three properties do the work, and each one closes a specific hole:
//
//   • "withheld" is a RECORD, not an absence. "No record" means the node has
//     not spoken yet (the gate should wait out its 2s poll); "withheld" means
//     the node has spoken and the answer is no (deny immediately). Collapsing
//     the two either stalls every denial by the wait window or loses AC-16's
//     no-round-trip guarantee to a poll race.
//   • a TTL, so a grant cannot outlive the work it was issued for.
//   • a prompt binding, so a grant is worth exactly ONE turn. The first tool
//     call binds it; a later turn presenting a different prompt id is refused
//     even though the grant is still inside its TTL. Without this, an owner's
//     grant would still be live when a non-owner's message arrives moments
//     later, and containment would leak through the gap.
//
// The agent cannot reach this directory: `ALWAYS_DENY` in capabilities.mjs
// blocks Read and Write on `**/.hive402/**`, and an unrecognised shell command
// is denied by the gate itself on a withheld turn.
//
// ── Fix cycle 3: one record per TRIGGERING EVENT, not one per agent (DD-20) ──
//
// The design above had one slot per agent, and cycle 3's F-009 broke it with
// two messages 40ms apart. The node wrote the owner's grant and then the
// non-owner's withhold into that same slot; the second overwrote the first; the
// owner's own turn was denied, parked, and — because the approval that followed
// released nothing but "you may research now" — the owner's approval was
// consumed by the non-owner's unrelated fetch instead.
//
// A single slot forces an impossible choice: overwrite (and break whoever was
// already running) or keep (and let the next turn inherit authority it was
// never given). Keyed by the event that triggered the turn, the choice does not
// arise — two messages are simply two authorities, and the turn gate
// (turngate.mjs) is what tells us which one this turn is entitled to.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Long enough for a slow model turn that fetches several pages, short enough
// that a grant nobody used stops mattering quickly. The prompt binding is the
// real single-turn guarantee; this is the backstop for a turn that dies.
export const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;

// A withheld record younger than this is treated as "the node decided about
// THIS turn" — the gate denies without waiting. Older than this and the gate
// assumes it may be racing the node's next poll and waits briefly.
export const FRESH_WITHHELD_MS = 60 * 1000;

export const CAPABILITIES = Object.freeze(["research", "build"]);

// The capabilities that never ride a NON-owner's automatic turn (DD-56, DD-57).
//
// AC-16 as amended in spec 0.7.0 ends the owner-side confirm: the owner's own
// turn carries everything the owner enabled, build included — "If I ask it
// auto does." What DD-35 got right survives on the other side of the line: a
// stranger's turn never holds `build` by default, auto-allow included. A
// non-owner's build ask is ESCALATED to the owner (AC-67) rather than granted
// or flatly refused. Deploy is not a capability at all — it is the node's own
// work (DD-27) and confirms once with the owner on its own merits, which is
// where AC-16's remaining exception now lives.
//
// F-019's lesson is not repealed by this, it is re-sited: what committed a
// run402 project and a public subdomain was the DEPLOY, and the deploy still
// asks. A local build commits nothing.
//
// Kept here, beside `CAPABILITIES`, because the node and the runtime gate both
// have to agree about it and a second copy is how they stop agreeing.
export const NEVER_AUTO_CROSS_OWNER = Object.freeze(["build"]);

// What the OWNER's own turn may do: everything the owner switched on. The
// owner's word is the whole gate (AC-16, spec 0.7.0) — a capability the owner
// disabled is still absent, which is AC-17's half of the bargain.
export function ownerTurnCapabilities(agent) {
  return CAPABILITIES.filter((c) => agent?.[c] === true);
}

// What anyone else's automatic turn may do (today: only via `auto-allow`):
// everything the owner switched on, minus what never rides a stranger's turn.
export function automaticCapabilities(agent) {
  return CAPABILITIES.filter((c) => agent?.[c] === true && !NEVER_AUTO_CROSS_OWNER.includes(c));
}

function safeName(agent) {
  return String(agent).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function grantPath({ stateDir, agent }) {
  return path.join(stateDir, "grants", `${safeName(agent)}.json`);
}

// Per-event authority. The event id comes from the harness (via the turn gate)
// and is a 64-char hex string, but it reaches the filesystem here, so it is
// sanitised like any other untrusted name — `..` must never become a directory
// traversal out of the state dir.
export function authorityPath({ stateDir, agent, eventId }) {
  return path.join(stateDir, "grants", safeName(agent), `${safeName(eventId)}.json`);
}

function write(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename: the gate reads this file from another process, and a
  // half-written file would fail closed — correct, but it would deny a
  // legitimate owner turn for no reason. Rename is atomic enough on both
  // platforms we run on.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return record;
}

// `eventId` names the room event whose turn this authority is for. Omitting it
// writes the legacy per-agent record, which is still read as a fallback for a
// runtime where the turn gate does not fire.
export function writeGrant({
  stateDir,
  agent,
  eventId = null,
  capabilities,
  reason = "",
  requester = null,
  proposalId = null,
  signature = null,
  ttlMs = DEFAULT_GRANT_TTL_MS,
  now = Date.now(),
}) {
  const wanted = (capabilities ?? []).filter((c) => CAPABILITIES.includes(c));
  const file = eventId ? authorityPath({ stateDir, agent, eventId }) : grantPath({ stateDir, agent });
  return write(file, {
    kind: "grant",
    agent,
    eventId,
    capabilities: wanted,
    reason,
    requester,
    // Set only for a grant released by an owner's approval (DD-21): the
    // proposal it answers, and the one tool call that proposal named.
    proposalId,
    signature,
    issuedAt: now,
    expiresAt: now + ttlMs,
    boundPromptId: null,
    consumedAt: null,
  });
}

export function writeWithheld({
  stateDir,
  agent,
  eventId = null,
  reason = "",
  requester = null,
  now = Date.now(),
}) {
  const file = eventId ? authorityPath({ stateDir, agent, eventId }) : grantPath({ stateDir, agent });
  return write(file, {
    kind: "withheld",
    agent,
    eventId,
    capabilities: [],
    reason,
    requester,
    proposalId: null,
    signature: null,
    issuedAt: now,
    // A withheld record must outlive the turn it refuses. It is keyed to that
    // turn's own event now, so it cannot leak onto anyone else's turn however
    // long it sits there.
    expiresAt: now + DEFAULT_GRANT_TTL_MS,
    boundPromptId: null,
    consumedAt: null,
  });
}

function readRecord(file) {
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    // A record we cannot understand is not a record. Fail closed.
    if (!record || (record.kind !== "grant" && record.kind !== "withheld")) return null;
    if (!Array.isArray(record.capabilities)) return null;
    return record;
  } catch {
    return null;
  }
}

export function readGrant({ stateDir, agent }) {
  return readRecord(grantPath({ stateDir, agent }));
}

export function readAuthority({ stateDir, agent, eventId }) {
  if (!eventId) return null;
  return readRecord(authorityPath({ stateDir, agent, eventId }));
}

// ── The turn the runtime could not name (FIX-87, fix cycle 11) ────────────
//
// FOUND BY RUNNING IT (2026-08-19): the owner posted `approve h4-1y5v5`, the
// node published the wake carrying the released grant, the grant landed on disk
// — and the agent's Write was refused with "capabilities are withheld for this
// turn". The grant file still read `boundPromptId: null`: nothing ever claimed
// it. The turn ledger counted a turn at 16:03:40Z and no turn record exists for
// it, so the turn gate ran and `parseTrigger` found no `[Buzz event:]` header.
//
// The harness runs with `meh=Queue` and steering support, so a message that
// arrives while the agent is mid-turn is delivered INTO the running turn rather
// than as a fresh prompt with its own header block. The approval wake landed 7
// seconds before the previous turn finished. The owner said yes and nothing
// happened — and the same mechanism explains cycle 6's F-015, where an owner's
// own build was refused for reasons nobody could reproduce.
//
// So: a turn the runtime could not attribute may claim ONE authority — and only
// an authority a human explicitly approved. Never an ordinary turn grant, which
// is what the per-agent fallback below would hand it.
//
// What still holds the line, because this is the security boundary:
//   • only records carrying a `proposalId` are eligible, so nothing an agent
//     could reach for by itself is claimable this way;
//   • `coversCapability` still checks the SIGNATURE, so the claimed approval
//     can only pay for the exact call the owner was shown (DD-21). That is what
//     makes this safe against the F-009 shape — a stranger's request bundled
//     into the same unattributed turn matches no signature;
//   • the claim binds it to this prompt, so a second turn gets nothing;
//   • the TTL still applies.
export function claimReleasedAuthority({ stateDir, agent, promptId, now = Date.now() }) {
  if (!promptId) return null;
  const dir = path.join(stateDir, "grants", safeName(agent));
  if (!existsSync(dir)) return null;

  let best = null;
  let bestEventId = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(path.join(dir, name));
    if (!record || record.kind !== "grant") continue;
    if (!record.proposalId) continue; // an approval, not an ordinary turn grant
    // Unclaimed, or already claimed by THIS turn — one turn makes many calls,
    // and each of them re-reads the same binding (the rule `claimAuthority`
    // follows). A record bound to somebody else's prompt is not ours.
    const mine = record.boundPromptId === promptId;
    if (record.boundPromptId && !mine) continue;
    if (record.consumedAt && !mine) continue;
    if (typeof record.expiresAt === "number" && record.expiresAt <= now) continue;
    if (!best || (record.issuedAt ?? 0) > (best.issuedAt ?? 0)) {
      best = record;
      bestEventId = name.replace(/\.json$/, "");
    }
  }
  if (!best) return null;
  return write(authorityPath({ stateDir, agent, eventId: bestEventId }), {
    ...best,
    boundPromptId: promptId,
  });
}

// Claim the grant for this turn. Only the FIRST caller binds it; every later
// call in the same turn re-reads the same binding and passes.
export function bindGrant({ stateDir, agent, promptId }) {
  if (!promptId) return null;
  const record = readGrant({ stateDir, agent });
  if (!record || record.kind !== "grant" || record.boundPromptId) return record;
  return write(grantPath({ stateDir, agent }), { ...record, boundPromptId: promptId });
}

// Claim this event's authority for this turn, and hand it back.
//
// The claim is what makes an authority worth exactly one turn: the first prompt
// to present the event binds it, and a later prompt presenting the same event
// reads a binding that is not its own and is refused by `coversCapability`. It
// is deliberately NOT a consume — every tool call inside one turn re-reads the
// same binding and passes.
export function claimAuthority({ stateDir, agent, eventId, promptId }) {
  const record = readAuthority({ stateDir, agent, eventId });
  if (!record || !promptId) return record;
  if (record.kind !== "grant" || record.boundPromptId) return record;
  return write(authorityPath({ stateDir, agent, eventId }), { ...record, boundPromptId: promptId });
}

// Mark a single-use grant spent. Only signature-bound approval grants are
// consumed this way (DD-21) — a turn grant is bound, not spent, because one
// turn legitimately makes many calls.
export function consumeAuthority({ stateDir, agent, eventId, now = Date.now() }) {
  const record = readAuthority({ stateDir, agent, eventId });
  if (!record || record.consumedAt) return record;
  return write(authorityPath({ stateDir, agent, eventId }), { ...record, consumedAt: now });
}

// Authority records accumulate one per message. They are TTL-bound, so the node
// sweeps the expired ones rather than letting the directory grow forever.
export function pruneAuthorities({ stateDir, agent, now = Date.now() }) {
  const dir = path.join(stateDir, "grants", safeName(agent));
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const record = readRecord(file);
    // An unreadable record is swept too: it can never authorise anything (the
    // reader fails closed on it), so leaving it costs a re-read every tick.
    if (record && typeof record.expiresAt === "number" && record.expiresAt > now) continue;
    try {
      rmSync(file, { force: true });
      removed += 1;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

// Does this record authorise this capability, for this turn, for THIS CALL,
// right now?
//
// `signature` is the identity of the call being attempted (see
// toolgate.toolSignature). A grant released by an owner's approval carries the
// signature of the one call that approval named, and only that call can spend
// it — the invariant F-009 was missing (DD-21).
export function coversCapability({ grant, capability, promptId, signature = null, now = Date.now() }) {
  if (!grant) return { ok: false, reason: "no capability grant for this turn", stale: true };
  if (grant.kind === "withheld") {
    return {
      ok: false,
      reason: "capabilities are withheld for this turn",
      fresh: now - grant.issuedAt < FRESH_WITHHELD_MS,
    };
  }
  if (typeof grant.expiresAt === "number" && grant.expiresAt <= now) {
    return { ok: false, reason: "the capability grant for this turn has expired", stale: true };
  }
  if (grant.consumedAt) {
    return { ok: false, reason: "that approval has already been used — one approval, one action" };
  }
  if (!grant.capabilities.includes(capability)) {
    // `fresh` here means the same thing it means for a withheld record: the
    // node has already spoken about THIS turn. It said what the turn may do,
    // and a capability missing from that list will not appear in it later — the
    // node writes one authority per event and never widens it in place. So the
    // gate must not spend its poll window waiting for a better answer; since
    // DD-35 this is the ordinary path for an owner's own build, and 2.5s of
    // waiting sat in front of every confirmation prompt.
    return { ok: false, reason: `this turn's grant does not cover "${capability}"`, fresh: true };
  }
  if (grant.signature && signature && grant.signature !== signature) {
    return {
      ok: false,
      reason:
        `the approval on this turn named a different action — it approved "${grant.signature}", ` +
        `not "${signature}"`,
    };
  }
  if (grant.signature && !signature) {
    return { ok: false, reason: "the approval on this turn named a specific action, and this is not it" };
  }
  if (grant.boundPromptId && promptId && grant.boundPromptId !== promptId) {
    return { ok: false, reason: "that grant was already used by another turn" };
  }
  return { ok: true, reason: grant.reason || "granted for this turn", proposalId: grant.proposalId ?? null };
}
