// FIX-124 — what the node missed while it was off (AC-2, AC-5, AC-7).
//
// ── The failure this replaces ──────────────────────────────────────────────
//
// `#currentWatermark` read the last 100 messages at start and marked every one
// of them handled, with a comment that is entirely correct about what it is
// preventing: "everything already in the room when we started is history, not a
// backlog. Without this, restarting the node re-answers every message it can
// see."
//
// What it does not say is what it costs. Barry asked the question that found it:
// "Say I turn OFF my computer and tal writes to smith. Then I turn it on
// tomorrow, will smith reply then?" No — and not because the message is out of
// reach. It is right there in the 100 the node reads. It is marked handled
// before the first tick and skipped forever, and nobody is told: not Tal, not
// the owner, not the room. A question sits in a channel with no answer and no
// explanation, which is the shape of a product that looks broken rather than
// asleep.
//
// So this is a WINDOW, not a removal. The old rule remains the default and three
// conditions together lift a single event out of it.
//
// ── Why a RESUME POINT, and not a shutdown time ────────────────────────────
//
// The obvious source for "what did I miss" is "when did I stop". It is the wrong
// one, and wrong in exactly the case that matters: the machine being switched
// off is precisely when `stop()` never runs, so the case Barry asked about is
// the case that would record nothing.
//
// So the node records where it GOT TO while it was alive — the `created_at` of
// the newest event it has processed. A crash, a power cut and a closed lid all
// leave the same usable record, because the record was written before any of
// them happened.
//
// ── The two bounds ─────────────────────────────────────────────────────────
//
// AGE, because "answer everything since I was last up" turns a week away into a
// week of replies to conversations that ended days ago. Past the window the
// right behaviour is to say so once, not to answer.
//
// COUNT, because a busy room can hold dozens of mentions INSIDE the window, and
// flushing those fires dozens of turns at once. What the cap drops is returned
// rather than swallowed: a silent cap reads as "there was nothing to answer",
// which is the failure this whole module exists to end.

import { resolveAddressed } from "../listener/mentions.mjs";

// Nostr `created_at` is unix SECONDS. Everything in this module is seconds, and
// the config is milliseconds like the rest of hive402 — the conversion happens
// once, at the caller, rather than at each comparison. Mixing the units is how a
// "12 hour" window silently becomes a 12-millisecond one.
const seconds = (value) => (Number.isFinite(value) ? Math.floor(value) : null);

// Split what the relay can still see into "already dealt with" and "missed".
//
// Returns the watermark the tick loop skips on, the events to hand the
// dispatcher, and how many were dropped by the count cap.
export function partitionOnResume({
  events = [],
  resumeFrom = null,
  agents = [],
  now,
  maxAgeSec,
  maxItems,
}) {
  const floor = now - maxAgeSec;
  // A node that has never run has no resume point, and the whole room is
  // history. This is deliberate and it is the more important half: someone
  // joining a channel with a year of chat in it, whose agent then answers a
  // mention from March, is a worse first impression than any silence.
  const since = resumeFrom == null ? Infinity : Math.max(resumeFrom, floor);

  const candidates = [];
  const watermark = new Set();
  // Mentions that arrived while the node was OFF but sit past the age bound.
  // They stay history — that is the window's whole job — but they are COUNTED,
  // because AC-66 says what the bounds drop is reported, never swallowed: an
  // unreported age-drop reads exactly like "there was nothing to answer",
  // which is the failure this module exists to end.
  //
  // FIX-164 (F-031, DD-65): the IDS, not just a tally. Whether a message was
  // really dropped is not knowable HERE — a promise is not a property of the
  // event, it is a separate AC-61 notice authored by another node and found by
  // a different query on a later pass. So each bound reports WHICH messages it
  // dropped and lets the pass that knows about promises decide the number. The
  // two counts are derived from these lists so they cannot drift from them.
  const agedOutIds = [];

  for (const event of events) {
    if (!event?.id) continue;
    const at = seconds(event.created_at);
    // An undateable event cannot be placed on either side of the line, so it
    // takes the safe side. An unanswered question can be asked again; an
    // unbidden reply to something undateable cannot be taken back.
    //
    // `at > now` is the same judgement about a hostile clock: `created_at` is
    // chosen by the sender, so without a ceiling anyone could sit permanently
    // inside every future backlog window by dating a message 2099.
    const dateable = at != null && at <= now;
    if (dateable && addressesOne({ event, agents })) {
      if (at > since) {
        candidates.push({ event, at });
        continue;
      }
      if (resumeFrom != null && at > resumeFrom && at <= floor) agedOutIds.push(event.id);
    }
    watermark.add(event.id);
  }

  // Oldest first, so a conversation replays in the order it was said.
  candidates.sort((a, b) => a.at - b.at);

  // When the cap bites, keep the NEWEST: those are the ones a person may still
  // be waiting on. The dropped ones go into the watermark like any other
  // history, because handing them to the dispatcher later would be the same
  // flood arriving one tick down.
  const over = Math.max(0, candidates.length - maxItems);
  const kept = over > 0 ? candidates.slice(over) : candidates;
  const droppedIds = [];
  for (const { event } of candidates.slice(0, over)) {
    watermark.add(event.id);
    droppedIds.push(event.id);
  }

  return {
    watermark,
    backlog: kept.map((c) => c.event),
    dropped: droppedIds.length,
    agedOut: agedOutIds.length,
    droppedIds,
    agedOutIds,
  };
}

// ── FIX-164 (F-031, DD-65): the join, in ONE place ─────────────────────────
//
// The bounds above know which messages they dropped. `#collectPromises` knows
// which messages this start is about to answer. Nothing joined them, so the
// node stated a number derived from age alone and then answered three of the
// messages it had just called unanswered.
//
// This is the only implementation of that join. A second, independently written
// reader of the same promise data is exactly how the count and the promise set
// came to disagree in the first place (DD-65, alternative 2).
//
// Note what is NOT subtracted: a promise the AC-64 cap refused is not in the
// promised set, so it stays counted. Those messages genuinely are not answered,
// and excluding them would make AC-66 understate a drop — AC-66's stated
// failure direction is silence, not repetition.
export function reconcileDrops({ agedOutIds = [], droppedIds = [], promisedIds = [] } = {}) {
  const lc = (id) => String(id).toLowerCase();
  const promised = new Set(asList(promisedIds).map(lc));
  const keep = (ids) => asList(ids).filter((id) => !promised.has(lc(id)));
  const aged = keep(agedOutIds);
  const capped = keep(droppedIds);
  return { agedOut: aged.length, dropped: capped.length, agedOutIds: aged, droppedIds: capped };
}

const asList = (value) => (Array.isArray(value) ? value : []);

// Is this addressed to one of OUR agents? Asked through the same primitive the
// dispatcher itself uses, so "addressed" cannot come to mean two different
// things in two places — a backlog that resolved mentions its own way would
// wake agents the live path would not, or miss ones it would.
function addressesOne({ event, agents }) {
  if (!agents.length) return false;
  const addressed = resolveAddressed({ content: event.content, tags: event.tags, agents });
  return addressed.length > 0;
}
