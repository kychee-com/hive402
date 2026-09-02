// Is this name already taken? (AC-56, FIX-118.)
//
// ── What this adds to what already existed ─────────────────────────────────
//
// `claimedNamesInRoom` (cycle 2, F-008) asks the ROOM who holds a name — the
// channel's members, and global `@name` resolution at the relay — and
// `validateRegistration` refuses on either. That is AC-37 and it works.
//
// AC-56 asks for two things that were missing:
//
//   1. "before the agent exists". The check ran at `register`, which is after
//      `keygen` minted a key, wrote it to the OS credential store, printed a
//      pubkey and told the operator to put it in their config. The clash was
//      reported about an identity that already existed and had to be cleaned up
//      by hand.
//   2. "the owner's own clients". An owner may already have an agent of that
//      name, made in Buzz Desktop under their own key. That is neither a room
//      clash nor a relay clash — it is the owner colliding with themselves, and
//      AC-56 says at minimum they are TOLD. Refusing would be wrong: they may
//      well mean to move that agent here, and that is their call, not ours.
//
// ── Whose agent is it? A ladder, not a flag (DD-69, FIX-175) ─────────────
//
// FIX-118 asked (2) with `buzz users get --name <n> --owner <hex>`, on the
// strength of that flag's help text — "Scope an exact-name agent lookup to its
// owner". **The help text is not what the command does.** It queries
// `{kinds:[30177], authors:[owner]}` — the managed-agent roster records only
// Buzz Desktop publishes (`crates/buzz-cli/src/commands/users.rs:128-139`,
// buzz `eed74bde2`) — matches on `content.name` and returns their `d` tags.
// `publisher.mjs` deliberately writes no 30177 record, so for every
// hive402-hosted agent the command returns `[]` at an early return, before any
// ownership code runs. The right owner and the wrong owner get the same empty
// array, which is why a same-owner collision read byte-for-byte like a
// stranger's even after FIX-171 wired the answer through to the refusal.
//
// So ownership is resolved from records that actually name an owner, cheapest
// first, each rung able only to ADD a true fact:
//
//   1. this hive's own config — the holder is listed here, with an owner.
//      Free, and covers "a second agent of mine, in another room of my hive".
//   2. the holder's own kind-0 NIP-OA `auth` tag, fetched raw through the
//      node's `/query` door and VERIFIED. Covers every owner-attested agent
//      anywhere on the relay, which is the case F-036 actually reports.
//   3. the Desktop roster — the `--owner` lookup, unchanged. It is the only
//      source that can answer AC-56's literal "the owner's own clients", and
//      it starts answering the moment a Desktop-made agent is the collision.
//   4. no claim.
//
// Rung 2 is a SIGNATURE, never the `about` string — which really does read
// `hive402 agent · hosted by 71a12235e894…` and would be far cheaper to match.
// AC-35 requires identification by verifiable attestation "never via display
// name", and the reason is this exact call site: `about` is unsigned display
// text, so a stranger who wrote the victim's prefix into their own profile
// would be introduced to that victim as their own agent. hive402's own message
// would become the forgery.
//
// Not a DD-17 violation, and the direction is why. DD-17 forbids the config as
// a source for the REFUSAL, because a config lists only its own author's
// agents and can therefore only under-report a clash (F-008). Rung 1
// ATTRIBUTES a pubkey the relay has already named. It cannot suppress a
// refusal, cannot invent a holder, and its worst failure is declining to add a
// sentence.
//
// ── `selfPubkey` belongs to a caller that HAS a self (DD-70, F-037) ───────
//
// `selfPubkey` is an EXCLUSION, not a narrowing hint. It means "this is the
// identity performing the check, so finding it is not a clash", and it is
// honoured in BOTH questions below that can produce a refusal — the room loop
// and the relay-wide `@name` lookup. A caller may pass it only when the
// identity it names already exists and IS the one being checked:
//
//   `register`  HAS a self. The config entry is the agent registering itself,
//               so finding it is not a collision. It passes `agent.pubkey`.
//   `keygen`    has NONE. It mints a key that does not exist yet, so a
//               config-declared agent of that name is a different identity
//               that already holds it — the clearest same-owner collision
//               there is. It passes nothing.
//   `setup`     the same, and for the same reason.
//
// Reading a pubkey out of the config and passing it here looks like narrowing
// and is the opposite: it silently empties `refusals`, which also kills rung 1
// above, since the ladder attributes the pubkeys those refusals named. That
// was F-037, and it reported a taken name as free while minting a key for it.
//
// ── Fail LOUD, never clean ────────────────────────────────────────────────
//
// F-008's cause was a check that could not see another owner's node and
// therefore always answered "no clash". So a check that could not run reports
// `checked: false` and the reason, and every caller prints it. "We could not
// ask" must never render as "there is nothing there".

import { agentOwner } from "./registration.mjs";
import { queryEvents as defaultQueryEvents } from "../relay/query.mjs";
import { nip98Header } from "../identity/nip98.mjs";

const lower = (value) => String(value ?? "").toLowerCase();
const nameOf = (profile) => profile?.display_name ?? profile?.name ?? null;

// Rung 1. The config is authoritative about the agents THIS hive hosts: it is
// where the operator declared the pubkey and the owner together, and `up`
// serves exactly those pairs. No relay call.
function ownerFromConfig(config, holder) {
  for (const room of config?.rooms ?? []) {
    for (const agent of room?.agents ?? []) {
      if (lower(agent?.pubkey) === holder) return lower(agent?.ownerPubkey) || null;
    }
  }
  return null;
}

// Rung 2. The holder's own kind-0, raw, through the door that keeps tags.
//
// `buzz users get` cannot answer this: it prints the kind-0 CONTENT with a
// `pubkey` spliced in and drops the event's tags (`users.rs:56-64`), so the
// attestation is unreachable through the command. `POST /query` returns whole
// events, and `agentOwner` is the same signature check the room's own
// identification runs (AC-35) — one place where ownership is decided, and it
// is the place that verifies.
//
// Returns null rather than throwing on every failure. This rung is additive:
// its worst outcome is declining to add a sentence, and a query that fails
// must never turn a refusal into "we could not check".
async function ownerFromAttestation({ holder, origin, privateKeyHex, queryEvents, nip98 }) {
  if (!origin || !privateKeyHex) return null;
  let rows;
  try {
    rows = await queryEvents({
      origin,
      filters: [{ kinds: [0], authors: [holder] }],
      privateKeyHex,
      nip98,
    });
  } catch {
    return null;
  }
  for (const event of rows ?? []) {
    // Verify against the pubkey of the profile the tag was FOUND on, never a
    // pubkey the caller supplied — that re-derivation is what makes a stolen
    // attestation useless (`nipoa.mjs`).
    if (lower(event?.pubkey) !== holder) continue;
    const attested = agentOwner(event);
    if (attested) return lower(attested);
  }
  return null;
}

export async function checkAgentName({
  cli,
  name,
  channel = null,
  selfPubkey = null,
  ownerPubkey = null,
  // The DD-69 ladder's two new sources. Both optional: a caller that has
  // neither gets exactly today's behaviour, which is what `keygen` before a
  // join, and every offline path, actually has.
  config = null,
  origin = null,
  privateKeyHex = null,
  queryEvents = defaultQueryEvents,
  nip98 = nip98Header,
}) {
  const empty = { refusals: [], warnings: [] };
  if (!cli) {
    return { ...empty, checked: false, reason: "no relay client — nothing was asked" };
  }

  const wanted = lower(name);
  const self = lower(selfPubkey);
  const refusals = [];
  const warnings = [];

  try {
    // 1. The room. Only when there is one — at `keygen` there may be no channel
    //    chosen yet, and the relay-wide question below does not need one.
    if (channel) {
      const members = (await cli.channelMembers({ channel })) ?? [];
      const seen = new Set();
      for (const member of members) {
        const pubkey = lower(member?.pubkey);
        if (!pubkey || pubkey === self || seen.has(pubkey)) continue;
        seen.add(pubkey);
        const held = nameOf(await cli.getUser({ pubkey }));
        if (held && lower(held) === wanted) refusals.push({ scope: "room", pubkey, name: held });
      }
    }

    // 2. The whole relay. `@name` resolution is a global kind-0 lookup, so a
    //    name someone else holds anywhere produces an agent that is admitted
    //    and unaddressable — worse than a refusal.
    const byName = await cli.getUser({ name });
    const holder = lower(byName?.pubkey);
    if (holder && holder !== self && !refusals.some((r) => r.pubkey === holder)) {
      refusals.push({ scope: "relay", pubkey: holder, name: nameOf(byName) ?? name });
    }

    // 3. The owner's own. Asked only when we know WHOSE — attributing a
    //    collision to the wrong identity would report a clash that is not one.
    if (ownerPubkey) {
      const wantedOwner = lower(ownerPubkey);

      // ── Rungs 1 and 2: attribute the pubkeys the questions above named ───
      //
      // These run over `refusals`, because a collision is the only thing there
      // is to attribute — the room and the relay have already said WHICH
      // pubkey holds the name, and the only open question is whose it is.
      for (const refusal of refusals) {
        const holderKey = lower(refusal.pubkey);
        const attested =
          ownerFromConfig(config, holderKey) ??
          (await ownerFromAttestation({
            holder: holderKey,
            origin,
            privateKeyHex,
            queryEvents,
            nip98,
          }));
        // Rung 4 lives here, as an absence: an agent attested by someone
        // else's node names no human owner of ours in any signed record, so
        // hive402 says nothing rather than guessing, and the cross-owner
        // wording stands unchanged.
        if (attested && attested === wantedOwner) {
          warnings.push({ scope: "owner", pubkey: holderKey, name: refusal.name ?? name });
        }
      }
    }

    // Rung 3, and the short-circuit. Skipped when a cheaper rung already
    // answered — one round trip saved on every same-owner collision — but
    // still made whenever they did not, because a Desktop-made agent has a
    // 30177 record and no hive402 attestation, and it is the ONLY thing that
    // can find one.
    if (ownerPubkey && warnings.length === 0) {
      const byOwner = await cli.getUser({ name, owner: ownerPubkey });
      const mine = lower(byOwner?.pubkey);
      // ── The dedup used to drop the more informative answer (F-036) ────────
      //
      // This condition carried `&& !refusals.some((r) => r.pubkey === mine)`,
      // so a pubkey that was BOTH a relay-wide `@name` hit and the owner's own
      // agent was recorded only as the refusal. Those are not alternatives:
      // "somebody holds this name" and "YOU hold this name" are different
      // facts, the second is strictly more useful, and suppressing it is the
      // whole reason a same-owner collision read byte-for-byte like a
      // stranger's.
      //
      // The dedup's real job — not reporting ONE clash twice — is unaffected.
      // It lives in the `refusals` list above, where the room question and the
      // relay question genuinely can return the same pubkey. This list is
      // populated once, by one lookup, so there was never a duplicate here to
      // prevent.
      if (mine && mine !== self) {
        warnings.push({ scope: "owner", pubkey: mine, name: nameOf(byOwner) ?? name });
      }
    }
  } catch (err) {
    return { ...empty, checked: false, reason: err.message };
  }

  return { checked: true, reason: null, refusals, warnings };
}

// The findings as sentences. Separated from the lookup so the wording is
// testable and so `keygen` and `register` say the same thing.
//
// `continuing` is the one thing that genuinely differs between the two callers
// (FIX-171). At `keygen`, and on `register`'s SUCCESS path, the command carries
// on despite the warning and says so. On `register`'s refusal path nothing was
// created, so "Continuing anyway" would be false — and pasting the success
// wording onto a refusal would be a worse message than the ownership-blind one
// it replaces. One flag rather than a second copy of the sentence, because two
// copies is how `keygen` and `register` start disagreeing.
export function describeNameFindings({ name, findings, continuing = true }) {
  const warnings = [];

  if (!findings.checked) {
    warnings.push(
      `could not check whether "${name}" is already taken (${findings.reason}). ` +
        `It may clash — "hive402 register" checks again against the room, and refuses there.`,
    );
    return { error: null, warnings };
  }

  for (const w of findings.warnings) {
    warnings.push(
      `you already have an agent called "${w.name}" (${w.pubkey.slice(0, 12)}…). ` +
        `Two of your own agents with one name are addressed by the same "@${name}", ` +
        `and which one answers is not something you control. ` +
        (continuing
          ? `Continuing anyway.`
          : `Nothing was created: retire that one, or give this agent a different name.`),
    );
  }

  const [refusal] = findings.refusals;
  if (!refusal) return { error: null, warnings };

  const held = refusal.pubkey.slice(0, 12);
  const error =
    refusal.scope === "room"
      ? `the name "${name}" is already published in this room by ${held}… — ` +
        `registering a second one would leave both unaddressable by name.`
      : `the name "${name}" already resolves on this relay to ${held}… — ` +
        `an agent registered into it would be admitted and unaddressable.`;
  return { error, warnings };
}
