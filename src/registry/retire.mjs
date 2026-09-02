// Giving a name back (AC-70, AC-71, DD-60).
//
// `register` claims a room-unique name (AC-37) and, until 0.8.0, nothing ever
// un-claimed one: an owner who decommissioned an agent — or lost its key — left
// that name unusable in that room forever. F-024 is the same defect rehearsed
// at rig scale, where the cover belt burned two display names on every cleanup.
//
// ── The lesson F-024 actually taught, which is not the obvious one ─────────
//
// The belt DID retire the kind-30177 registry record. It burned the names
// anyway, because **the registry is not the surface that refuses a
// registration**. `roomnames.mjs` — the reader `register` consults — reads each
// channel member's kind-0 DISPLAY NAME plus the relay's global name index, and
// never reads 30177 at all. Retiring the record alone looks like success and
// frees nothing.
//
// So retirement releases BOTH surfaces, and it releases them in an order that
// cannot half-succeed:
//
//   1. RENAME the agent's own kind-0 to a dead form. Do this FIRST, because a
//      crash after it leaves the name FREE with a stale record behind — the
//      recoverable direction. The reverse (record gone, name held, key later
//      destroyed) is exactly how the belt burned names permanently.
//   2. READ BACK, with the reader that would refuse the next registration, at
//      BOTH scopes. A rename that satisfied the room scan while leaving the
//      global index resolving reads clean and refuses the next run.
//   3. TOMBSTONE the registry record, as the node that published it.
//
// And what it cannot free, it says so about. A name whose signing key is gone
// cannot be released by anyone — the claim is signed, so without the key there
// is nothing to un-sign it with. The honest answer is a refusal naming the
// holder and the scope, never a cheerful "retired" that leaves the room unable
// to reuse the name (AC-71).

import { buildManagedAgentTombstone } from "../identity/managedagent.mjs";
import { nip98Header } from "../identity/nip98.mjs";
import { submitEvent as defaultSubmitEvent } from "../relay/query.mjs";
import { claimedNamesInRoom } from "./roomnames.mjs";

const lower = (v) => String(v ?? "").toLowerCase();
const short = (v) => String(v ?? "").slice(0, 8);

// The name the identity keeps once it has given its own back.
//
// It MUST carry the identity. A fixed `retired-<name>` collides with itself the
// second time an agent of that name is retired in the same room — the same bug
// one rename along, and the hand-cleanup that inspired this only escaped it by
// running once. The profile is renamed rather than deleted because a vanished
// profile and a renamed one both read "free" to a naive check; keeping a dead
// name is what makes the read-back in step 2 discriminating.
export function retiredNameFor(name, agentPubkey) {
  return `retired-${name}-${short(agentPubkey)}`;
}

// Who may retire this agent? (AC-71, first clause.)
//
// The same rule as AC-19's "only the owner changes this agent", one surface
// over — plus the node, which hosts it and is the only party that can retire
// the record it authored. Everyone else is refused: a name claimed by somebody
// else's key is not theirs to take.
export function authorizeRetire({ agent, actorPubkey, nodePubkey }) {
  if (!agent) {
    return {
      ok: false,
      reason:
        "no agent by that name is hosted by this node — retiring is done where the agent runs, " +
        "by the node that registered it",
    };
  }
  const actor = lower(actorPubkey);
  if (actor && actor === lower(agent.ownerPubkey)) return { ok: true, as: "owner" };
  if (actor && actor === lower(nodePubkey)) return { ok: true, as: "node" };
  return {
    ok: false,
    reason:
      `only ${agent.name}'s owner (${short(agent.ownerPubkey)}…) or the node hosting it ` +
      `(${short(nodePubkey)}…) can retire it`,
  };
}

// Is the name free, at both scopes, according to the reader that decides?
//
// `claimedNamesInRoom` answers for channel members (`scope: "room"`) and for the
// relay's global lookup (`scope: "relay"`) — but it raises the relay claim only
// when the holder is NOT already a channel member, and our agent IS one. So the
// global index is asked directly as well, or a release that satisfied the room
// scan and left `@name` still resolving to us would read clean here and refuse
// the next registration.
//
// The direct question cannot be "does anything come back": `users get --name`
// is a TOKEN match upstream, so `spike` returns a profile actually called
// `retired-spike-43e1b966`. The question is "does anything still CALL ITSELF
// this".
export async function nameHolders({ cli, channel, name }) {
  const held = [];
  const claims = await claimedNamesInRoom({ cli, channel, exceptPubkey: null, name });
  for (const claim of claims) {
    if (lower(claim.name) === lower(name)) held.push({ pubkey: claim.pubkey, scope: claim.scope });
  }
  const hit = await cli.getUser({ name });
  const hitName = hit?.display_name ?? hit?.name ?? "";
  if (hit && lower(hitName) === lower(name)) {
    const pubkey = lower(hit.pubkey);
    if (!held.some((h) => lower(h.pubkey) === pubkey)) held.push({ pubkey, scope: "relay" });
  }
  return held;
}

const describe = (held) => held.map((h) => `${short(h.pubkey)}… (scope: ${h.scope})`).join(", ");

export async function retireAgent({
  agent,
  channel,
  nodePubkey,
  nodeKeyRef = "keychain",
  origin,
  resolveKey,
  makeCli,
  submitEvent = defaultSubmitEvent,
  nip98 = nip98Header,
  now = Date.now(),
}) {
  const base = { agent: agent?.name ?? null, released: false, retired: false, freeAt: [] };

  // ── 0. No key, no release — and nothing written on a run that cannot win ──
  //
  // AC-71's second clause. The kind-0 claim is signed by the agent's own
  // identity, so without that key the name genuinely cannot be given back by
  // anyone. Resolving it FIRST means a keyless retire writes nothing at all
  // rather than tombstoning a record for a name it then fails to free.
  let agentKey;
  try {
    agentKey = await resolveKey(agent.privateKeyRef, { agent: agent.name });
    if (!agentKey) throw new Error("the credential store returned nothing");
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason:
        `cannot retire "${agent.name}": its signing key is not available here (${err.message}), and the ` +
        `kind-0 name claim can only be released by the identity that made it. The name stays taken, ` +
        `held by ${short(agent.pubkey)}…. Nothing was changed.`,
    };
  }

  // ── 1. Release the display name, as the agent ────────────────────────────
  //
  // Through `setProfile`, which upstream is read-merge-write: sending only
  // `name` renames the profile and leaves `about` and the avatar exactly as the
  // node published them. A hand-rolled kind-0 would silently clear both.
  const released = retiredNameFor(agent.name, agent.pubkey);
  const agentCli = makeCli({ role: "agent", as: agent.pubkey, privateKey: agentKey });
  try {
    await agentCli.setProfile({ name: released });
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason:
        `cannot retire "${agent.name}": the relay refused the rename that gives its name back ` +
        `(${err.message}). Nothing else was changed — the record outlives a name we could not free.`,
    };
  }

  // ── 2. Prove it, before anything claims success ──────────────────────────
  const result = { ...base, released: true, releasedAs: released };
  let held;
  try {
    held = await nameHolders({ cli: agentCli, channel, name: agent.name });
  } catch (err) {
    return {
      ...result,
      ok: false,
      reason: `"${agent.name}" was renamed, but the release could not be verified (${err.message})`,
    };
  }
  if (held.length > 0) {
    // Our own claim IS released — that part is true and is reported. What is
    // not true, and must never be reported, is that the NAME is free.
    result.released = false;
    result.heldBy = held;
    result.reason =
      `"${agent.name}" is still held by ${describe(held)}, so retiring this agent does not free it. ` +
      `A claim can only be released by the key that made it.`;
  }

  // ── 3. Retire the registry record, as the node ───────────────────────────
  try {
    const nodeKey = await resolveKey(nodeKeyRef, { role: "node" });
    const event = buildManagedAgentTombstone({ agentPubkey: agent.pubkey, nodePrivateKeyHex: nodeKey, now });
    await submitEvent({ origin, event, privateKeyHex: nodeKey, nip98, now });
    result.retired = true;
  } catch (err) {
    result.recordError = err.message;
    if (!result.reason) {
      result.reason =
        `"${agent.name}" gave its name back, but its registry record could not be retired ` +
        `(${err.message}). The name is FREE; the stale record is safe to leave and this is safe to re-run.`;
    }
  }

  if (result.released && result.retired) {
    result.freeAt = ["room", "relay"];
    result.ok = true;
  } else {
    result.ok = false;
  }
  return result;
}
