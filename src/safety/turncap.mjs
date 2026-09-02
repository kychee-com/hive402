// TurnCap — the fuse (spec AC-26).
//
// Pure counting, no model calls: each agent gets N model turns per rolling
// hour. On the cap the agent pauses and the room is told once. Buzz ships no
// such guard, and its own engineering notes record a 21-reply runaway plus a
// field report of an exhausted model plan — so this is a structural invariant,
// not a tunable.
const HOUR_MS = 60 * 60 * 1000;

// Since fix cycle 3 the counting happens in the agent's own runtime (see
// src/runtime/turngate.mjs, DD-23), because that is the only place that sees
// the turns buzz-acp delivers straight to an agent's owner — the ones F-011
// showed sailing past this cap entirely.
//
// So when a `ledger` is supplied, this class stops being the counter and
// becomes the node's READER of it: same numbers for `/turns` and the pause
// notice, no second tally. Without one it behaves exactly as before, which is
// what keeps it unit-testable on its own.
export class TurnCap {
  #limit;
  #windowMs;
  #now;
  #ledger;
  #turns = new Map(); // agent -> timestamps[]
  #announced = new Set(); // agents already told the room they're paused

  constructor({ limit = 20, windowMs = HOUR_MS, now = () => Date.now(), ledger = null } = {}) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
    this.#ledger = ledger;
  }

  #live(agent) {
    if (this.#ledger) return new Array(this.#ledger.used(agent)).fill(0);
    const cutoff = this.#now() - this.#windowMs;
    const kept = (this.#turns.get(agent) ?? []).filter((t) => t > cutoff);
    this.#turns.set(agent, kept);
    return kept;
  }

  remaining(agent) {
    return Math.max(0, this.#limit - this.#live(agent).length);
  }

  // Consume one turn. Returns { allowed, notice } — `notice` is a room-visible
  // message emitted once per pause, so a blocked agent doesn't spam the channel.
  //
  // With a ledger this only CHECKS: the runtime has already recorded, or will
  // record, the turn itself. Recording here too would count node-routed traffic
  // twice and owner traffic once.
  tryConsume(agent) {
    const live = this.#live(agent);

    if (live.length >= this.#limit) {
      if (this.#announced.has(agent)) {
        return { allowed: false, notice: null };
      }
      this.#announced.add(agent);
      const mins = Math.ceil(this.#windowMs / 60000);
      return {
        allowed: false,
        notice:
          `Pausing: I've used my limit of ${this.#limit} turns in the last ` +
          `${mins} minutes. I'll pick back up as that window rolls forward.`,
      };
    }

    if (!this.#ledger) {
      live.push(this.#now());
      this.#turns.set(agent, live);
    }
    this.#announced.delete(agent); // fresh budget → allowed to announce again
    return { allowed: true, notice: null };
  }
}
