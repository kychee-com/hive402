// The handoff set — what did the node give the harness, and did anyone answer?
// (FIX-135, F-023, AC-7.)
//
// When a message is `p`-tagged, its author reaches the agent directly, and the
// agent's process is alive, the node emits no wake: buzz-acp has the message,
// and relaying it as well would double every one of the owner's turns. That
// reasoning is correct about DELIVERY and blind about ANSWERING. Liveness is a
// process fact; it cannot see that the agent is mid-turn, and buzz-acp's
// `meh=Queue` steering folds a message that arrives mid-turn into the RUNNING
// turn. If the model does not address it, nothing anywhere notices: no wake,
// no turn record, no audit row. A human's own messages disappear while every
// stranger's message in the same burst is answered, because a stranger's takes
// the relay path and gets its own wake.
//
// So the node keeps the receipt. Each direct handoff enters this set, every
// reply the room produces is offered to it, and after a grace window a handoff
// with no answer from the agent is relayed through the ORDINARY wake path —
// the same path the stranger's message already takes successfully. Nothing
// here reads the message text, decides what it meant, or changes who may do
// what: the only question asked is "did the agent reply in that thread?", and
// the only action available is the wake that would have happened anyway.
//
// ── The ambiguity this cannot resolve, and does not pretend to ─────────────
//
// A folded message that the model DID address is answered inside the reply to
// the message it was folded into — a different thread — so from outside it is
// indistinguishable from one that was dropped. Resolving it would mean reading
// the reply's text and deciding what it covered, which is the wake path's
// oldest defect class in this product (F-007, F-013). The node relays instead
// and says so in the wake, exactly as the replay note does for AC-65: the
// agent is the one party that knows, so the agent is asked.
//
// The failure directions are deliberately asymmetric. Not relaying loses a
// human's message with no trace. Relaying at worst produces a brief "I already
// covered that" in a thread where somebody was waiting anyway.
//
// `decide` proposes; it never commits. The caller confirms after the relay
// accepted the wake (`confirmRecovered`), so a failed publish retries next
// tick instead of dropping the message a second time — the same
// effect-then-confirm shape cover and the authority records use.
//
// Everything here is pure and injected — events in, effects out — so the whole
// policy is testable without a relay, like the dispatcher and CoverTracker.

import { replyAnchor, replyTargetOf, threadRootOf } from "../listener/threads.mjs";
import { threadVerdict } from "./promises.mjs";

const lc = (value) => String(value ?? "").toLowerCase();

// A busy thread must not grow an unbounded reply list while one handoff waits
// out its window. Only the presence of an agent reply matters, so keeping the
// most recent few is as good as keeping all of them.
const REPLIES_PER_HANDOFF = 50;

export class HandoffTracker {
  // "<event id>:<agent pubkey>" -> { event, agent, handedAtSec, anchor, replies }
  //
  // This is the WHOLE of the state, and the first cut had one more field: a
  // `#recovered` set, so a message could be relayed only once ever. The
  // discrimination pass (remove one behaviour, see which tests redden) showed
  // it reddened NOTHING — a receipt is only ever recorded from a message the
  // supervisor is dispatching for the first time, so the set could never be
  // consulted. That is this product's recurring defect class 2 (a mechanism
  // with no caller under a green suite), and the honest fix is to delete it:
  // "recovered once" is enforced by removing the pending entry, which is
  // load-bearing and reddens its test.
  #pending = new Map();
  // Bounded memory for a long-lived room, same cap as the cover tracker's.
  #cap = 500;

  #key(eventId, agentPubkey) {
    return `${lc(eventId)}:${lc(agentPubkey)}`;
  }

  // The node handed this message over. `route` says HOW, and it is carried
  // rather than assumed because the two routes end in different sentences:
  // "delivered directly" is false for every relayed recovery, and a correct
  // boolean inside a wrong sentence is this codebase's other standing sin.
  //
  // Both routes ask the same question and key on the same anchor. `record`
  // stores `replyAnchor(event)`; the relayed wake is published with
  // `replyTo: replyAnchor(event)` — the same call on the same event — and
  // buzz-acp derives the agent's own `--reply-to` from that wake's thread tags.
  // So the agent's reply carries the thread root this receipt is already keyed
  // to, and no new matching rule is needed for the second route.
  record({ event, agent, nowSec, route = "direct" }) {
    if (!event?.id || !agent?.pubkey) return;
    const key = this.#key(event.id, agent.pubkey);
    if (this.#pending.has(key)) return;
    this.#pending.set(key, {
      event,
      agent,
      route,
      // The node's own clock, not `created_at`: a sender-chosen timestamp must
      // not be able to buy itself an instant recovery or an infinite wait.
      handedAtSec: nowSec,
      anchor: lc(replyAnchor(event)),
      replies: [],
    });
    if (this.#pending.size > this.#cap) {
      this.#pending.delete(this.#pending.keys().next().value);
    }
  }

  // Every event the room produced this tick, offered to whichever handoffs it
  // could be an answer to. The thread test is the coarse one cover uses and
  // for the same reason: the agent's reply anchors to the thread ROOT, so
  // demanding a direct reply marker would miss real answers, and the failure
  // direction of the coarseness is a suppressed recovery — never a duplicate.
  observe({ event }) {
    if (event?.kind !== 9 || !event.id) return;
    const thread = lc(threadRootOf(event) ?? replyTargetOf(event) ?? "");
    if (!thread) return;
    for (const entry of this.#pending.values()) {
      if (entry.anchor !== thread) continue;
      entry.replies.push(event);
      if (entry.replies.length > REPLIES_PER_HANDOFF) entry.replies.shift();
    }
  }

  hasPending() {
    return this.#pending.size > 0;
  }

  // Propose what to relay NOW; commit nothing.
  //
  // `machineAuthors` is threaded straight into `threadVerdict` — the one
  // answer in this product to "did the agent reply to this message?", built
  // for AC-63/AC-65's replay. There is no second answer to that question here.
  decide({ nowSec, graceSec, machineAuthors = [] }) {
    const effects = [];
    for (const [key, entry] of [...this.#pending.entries()]) {
      const { event, agent, handedAtSec, replies, route } = entry;

      // The earlier of the two clocks, so a reply that beat the node's own
      // reading of the tick still counts. Both directions of the skew matter
      // and only one is safe: an answer missed here becomes a DUPLICATE in a
      // shared room, while an extra answer counted here is at worst a missed
      // recovery, which is exactly today's behaviour.
      const afterSec = Math.min(
        handedAtSec,
        Number.isFinite(event.created_at) ? event.created_at : handedAtSec,
      );
      const { answeredByAgent } = threadVerdict({
        replies,
        agentPubkey: agent.pubkey,
        machineAuthors,
        afterSec,
      });
      if (answeredByAgent) {
        // The harness did its job. This is the overwhelmingly common case, and
        // closing it here is what keeps the recovery path off every healthy
        // turn in the room.
        this.#pending.delete(key);
        continue;
      }

      if (nowSec - handedAtSec < graceSec) continue; // the turn could still be running

      effects.push({ type: "recover", agent, event, route });
    }
    return effects;
  }

  // The relay accepted the recovery wake for this (message, agent): stop
  // proposing it. Dropping the receipt is what makes "recovered once" true —
  // nothing re-records a message the supervisor has already dispatched.
  confirmRecovered({ event, agent }) {
    this.#pending.delete(this.#key(event?.id, agent?.pubkey));
  }
}
