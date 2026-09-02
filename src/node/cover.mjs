// The pending set — when does a covering node speak? (F-11: AC-61, AC-62,
// DD-54.)
//
// A mention of a foreign agent does not draw a notice at the moment it is
// seen, because "offline" cannot be read at a moment: the relay holds presence
// with a 3-minute expiry, so a node that died one second before the ask still
// reads online. The mention enters a PENDING set instead, and every tick asks
// three questions — answered? noticed? owner-node offline? — until one of
// them closes it or the window does.
//
// The window is AC-61's own bound: five minutes from the mention. A node that
// dies AFTER surviving the window is not this path's problem — the mention
// falls to the owner-node's ordinary catch-up (AC-66), which is the
// conservative direction: a missed notice degrades to today's behaviour, a
// wrong notice would be a false promise in a shared room.
//
// The unit of promise is (message, agent). One message can address two
// offline agents, and each is owed its own sentence; a standing notice
// therefore suppresses only the agent it names.
//
// `decide` proposes; it never commits. The caller confirms each notice AFTER
// the relay accepted it (`confirmPosted`), so a failed send retries on the
// next tick instead of silently dropping a promise — the same
// effect-then-confirm shape the wake path's authority records use.
//
// Everything here is pure and injected — events and presence in, effects out —
// so the whole policy is testable without a relay, like the dispatcher.

import { awayNotice, awayNoticeName, isAwayNotice } from "../listener/notices.mjs";
import { foreignMentions } from "../listener/foreign.mjs";
import { replyTargetOf, threadRootOf } from "../listener/threads.mjs";

// AC-61: "exactly one notice is posted within 5 minutes".
export const PENDING_WINDOW_SEC = 300;

// How much longer each further live node waits before speaking (DD-54). Rank 0
// posts as soon as offline is established; rank 1 gives rank 0 this long to
// have done it. Two ticks of margin over the poll interval, an order of
// magnitude under the window.
export const RANK_DELAY_SEC = 20;

const lc = (value) => String(value ?? "").toLowerCase();

export class CoverTracker {
  // "<event id>:<agent pubkey>" -> { event, agent, firstSeenSec }
  #pending = new Map();
  // Promises already standing, keyed like #pending — anyone's notice counts,
  // including our own once confirmed. For dedup, a standing notice means the
  // room was told, whoever told it. (Replay trusts more narrowly; that is its
  // module's business, not this one's.) A notice whose name cannot be matched
  // to the roster lands under "*": suppress everything for that message
  // rather than second-guess a sentence somebody already posted.
  #noticed = new Set();
  // Bounded memory for a long-lived room.
  #cap = 500;

  #key(eventId, agentPubkey) {
    return `${lc(eventId)}:${lc(agentPubkey)}`;
  }

  #isNoticed(eventId, agentPubkey) {
    return this.#noticed.has(this.#key(eventId, agentPubkey)) || this.#noticed.has(`${lc(eventId)}:*`);
  }

  #remember(key) {
    this.#noticed.add(key);
    if (this.#noticed.size > this.#cap) {
      this.#noticed.delete(this.#noticed.values().next().value);
    }
  }

  // Feed one observed room event through. `foreign` is the channel's foreign
  // roster ({pubkey, name, node}); `isEligibleAuthor` says whether this
  // author's mentions deserve cover at all — humans yes; agents and nodes no
  // (an agent's chatter is loop-guard territory, and a node's wakes QUOTE the
  // "@name" they relay, which must never read as a fresh ask).
  observe({ event, foreign, nowSec, isEligibleAuthor = () => true }) {
    if (event?.kind !== 9 || !event.id) return;

    // A standing notice — ours or anyone's — closes the question for the
    // agent it names on its target message.
    if (isAwayNotice(event.content)) {
      const target = replyTargetOf(event);
      if (!target) return;
      const name = lc(awayNoticeName(event.content));
      const named = foreign.find((f) => lc(f.name) === name);
      this.#remember(named ? this.#key(target, named.pubkey) : `${lc(target)}:*`);
      for (const [key, entry] of this.#pending) {
        if (lc(entry.event.id) !== lc(target)) continue;
        if (!named || lc(entry.agent.pubkey) === lc(named.pubkey)) this.#pending.delete(key);
      }
      return;
    }

    // An answer from the agent itself, anywhere in the mention's thread,
    // closes every pending entry it answers. The thread test is coarse on
    // purpose: the agent's reply anchors to the thread ROOT (the flat-reply
    // rule), so demanding a direct reply marker to the mention would miss
    // real answers. The failure direction of the coarseness is a suppressed
    // notice, never a false one.
    const author = lc(event.pubkey);
    let answered = false;
    for (const [key, entry] of [...this.#pending.entries()]) {
      if (lc(entry.agent.pubkey) !== author) continue;
      const mentionThread = threadRootOf(entry.event) ?? entry.event.id;
      const replyThread = threadRootOf(event) ?? replyTargetOf(event);
      if (lc(replyThread ?? "") === lc(mentionThread)) {
        this.#pending.delete(key);
        answered = true;
      }
    }
    if (answered) return;

    if (!isEligibleAuthor(event.pubkey)) return;

    // A mention already outside the window when first observed is history, not
    // a live ask — start-up backlogs must not produce a burst of stale
    // notices. `created_at` is sender-chosen, so it is clamped to now: a
    // future-dated mention cannot buy itself a longer window.
    const at = Number.isFinite(event.created_at) ? Math.min(event.created_at, nowSec) : null;
    if (at === null || nowSec - at > PENDING_WINDOW_SEC) return;

    for (const agent of foreignMentions({ event, foreign })) {
      if (this.#isNoticed(event.id, agent.pubkey)) continue;
      const key = this.#key(event.id, agent.pubkey);
      if (this.#pending.has(key)) continue;
      this.#pending.set(key, { event, agent, firstSeenSec: at });
      if (this.#pending.size > this.#cap) {
        this.#pending.delete(this.#pending.keys().next().value);
      }
    }
  }

  // The owner-node pubkeys the caller should fetch presence for.
  pendingNodes() {
    return [...new Set([...this.#pending.values()].map((entry) => entry.agent.node))];
  }

  hasPending() {
    return this.#pending.size > 0;
  }

  // Propose what to post NOW; commit nothing. `presence(nodePubkey)` answers
  // "online" | "away" | "offline" | null (null = could not read, which means
  // wait — a network blip must never produce a false "not online" in a shared
  // room). `rankOf(agent)` is this node's rank among the live covering nodes.
  decide({ nowSec, presence, rankOf }) {
    const effects = [];
    for (const [key, entry] of [...this.#pending.entries()]) {
      const { event, agent, firstSeenSec } = entry;

      if (nowSec - firstSeenSec > PENDING_WINDOW_SEC) {
        this.#pending.delete(key);
        continue;
      }
      if (this.#isNoticed(event.id, agent.pubkey)) {
        this.#pending.delete(key);
        continue;
      }

      const status = presence(agent.node);
      if (status === null || status === undefined) continue; // unreadable — wait
      if (status === "online") continue; // reachable — its own node's business

      // Offline (or away, which still means "nothing is hosting an answer").
      if (nowSec < firstSeenSec + rankOf(agent) * RANK_DELAY_SEC) continue;

      effects.push({
        type: "notice",
        agent,
        event,
        // Threaded onto the SPECIFIC mention: the CLI derives the thread root
        // itself, and the mention's id survives as the notice's reply marker —
        // which is what makes the notice the durable pointer (S30-2).
        replyTo: event.id,
        content: awayNotice({ name: agent.name }),
      });
    }
    return effects;
  }

  // The relay accepted our notice for this (message, agent): the promise
  // stands, stop proposing it.
  confirmPosted({ event, agent }) {
    const key = this.#key(event.id, agent.pubkey);
    this.#pending.delete(key);
    this.#remember(key);
  }
}
