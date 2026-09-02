// Mention resolution — the piece that makes cross-owner addressing work from
// ANY client.
//
// Buzz Desktop cannot emit a `p` tag for an agent it does not manage, so a
// human typing "@blitz" there produces plain text the agent never sees. The
// spike (2026-08-15) confirmed the wake trigger is the `p` tag: a plain kind-9
// produced zero agent activity, a p-tagged kind-9 dispatched a turn.
//
// So the listener watches the room, resolves "@name" in TEXT against the
// room's agents, and wakes the ones the sender's client failed to tag.
//
// ── …and text is not the only way a client spells an address (AC-6, FIX-109) ─
//
// Upstream #6315 (buzz @ a2d8be5ef) lets Desktop keep an agent addressed in a
// channel after the first @mention. Every message after that carries the
// address as a TAG and nothing else — `["mention", <pubkey>]`, or the same with
// a third element "agent-address" — while the body text names nobody.
//
// A body-text-only matcher reads those as addressing no one, and the two ways
// that fails are not the same failure. A non-owner's tray-addressed message is
// dropped by the agent's inbound allowlist AND never relayed by the node, so
// the agent is silent, which AC-5 forbids. The owner's is delivered by the
// harness — the `p` tag is still the notification mechanism — so a turn starts,
// but the node recognised no address and wrote no authority record for it, so
// the turn runs with nothing granted and an enabled capability quietly does
// nothing.
//
// The validity rules below are upstream's, deliberately copied rather than
// invented: `desktop/src-tauri/src/events/message_tags.rs::mention_reference_tags`
// requires tag[0] === "mention", at most three elements, the third (when
// present) to be exactly "agent-address", and a pubkey that passes
// `check_pubkey` — exactly 64 ASCII-hex characters — which it then lowercases.
// A tag hive402 accepts and Buzz rejects would be a second opinion about who
// was addressed, and two opinions is how the room and the node disagree.

const KIND_MESSAGE = 9;

// Name chars: letters, digits, _ and - (so "@blitzkrieg" does not match
// "blitz", but "@blitz," does).
const MENTION_RE = /@([A-Za-z0-9_-]+)/g;

const AGENT_ADDRESS_MARKER = "agent-address";
const PUBKEY_RE = /^[0-9a-fA-F]{64}$/;

export function resolveMentions(text, agents) {
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a.pubkey]));
  const found = new Set();
  for (const m of String(text ?? "").matchAll(MENTION_RE)) {
    const pubkey = byName.get(m[1].toLowerCase());
    if (pubkey) found.add(pubkey);
  }
  return [...found];
}

// The pubkeys addressed by an event's `mention` tags, normalised to lowercase.
//
// Anything malformed is dropped silently, which is what upstream does with the
// same tag: `mention_reference_tags` returns an error and the message is never
// built, so a malformed tag never reaches a relay in the first place. Reading
// one leniently here would mean hive402 waking an agent on a tag no Buzz client
// could have sent.
export function mentionTagPubkeys(tags) {
  const found = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (!Array.isArray(tag) || tag.length < 2 || tag.length > 3) continue;
    if (tag[0] !== "mention") continue;
    if (tag.length === 3 && tag[2] !== AGENT_ADDRESS_MARKER) continue;
    const pubkey = tag[1];
    if (typeof pubkey !== "string" || !PUBKEY_RE.test(pubkey)) continue;
    found.add(pubkey.toLowerCase());
  }
  return [...found];
}

// Who does this message address? The union of both spellings, deduplicated —
// a message carrying "@spike" AND spike's mention tag is one address, and
// waking twice for it would dispatch the same turn twice.
//
// This is the ONE resolver. `p` tags are deliberately not consulted: a `p` tag
// is how the relay delivers, not a statement about who was being spoken to, and
// reading it as an address would wake every agent a sender merely cc'd.
export function resolveAddressed({ content, tags, agents }) {
  const byPubkey = new Map(agents.map((a) => [a.pubkey.toLowerCase(), a.pubkey]));
  const found = new Set(resolveMentions(content, agents));
  for (const pubkey of mentionTagPubkeys(tags)) {
    const known = byPubkey.get(pubkey);
    if (known) found.add(known);
  }
  return [...found];
}

// decideWake — should the listener publish a wake for this event, and for whom?
//
// Returns { wake: [pubkey...], reason }. An empty wake list is the common,
// correct case: most room traffic addresses nobody.
export function decideWake({ event, agents }) {
  if (event?.kind !== KIND_MESSAGE) {
    return { wake: [], reason: "not a channel message" };
  }

  // AC-25 / loop guard: agent-authored messages never trigger wakes. In step 1
  // agents reach each other only by explicit p-tag, never via text matching.
  if (agents.some((a) => a.pubkey === event.pubkey)) {
    return { wake: [], reason: "agent-authored — never wakes agents" };
  }

  // The same resolver the dispatcher uses (FIX-109). This function has no
  // production caller — `Dispatcher.handle` is the live wake path — but a
  // SECOND, divergent answer to "who was addressed?" sitting in the same module
  // is a trap: the next reader fixes this one and believes the product changed.
  // Sharing the resolver means it cannot drift.
  const mentioned = resolveAddressed({ content: event.content, tags: event.tags, agents });
  if (mentioned.length === 0) {
    return { wake: [], reason: "no agent addressed" };
  }

  // Already-tagged agents were delivered by the relay's own #p filter — waking
  // them again would double-dispatch the same turn.
  const alreadyTagged = new Set(
    (event.tags ?? []).filter((t) => t[0] === "p").map((t) => t[1]),
  );
  const wake = mentioned.filter((pk) => !alreadyTagged.has(pk));

  return {
    wake,
    reason: wake.length ? "addressed by name, untagged by sender" : "already p-tagged",
  };
}
