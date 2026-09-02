// LoopGuard — structural stop for agent-to-agent runaway (spec AC-24).
//
// Buzz ships no reply-depth counter, hop limit, cooldown, or budget anywhere on
// the wake path; its own engineering notes record a 21-reply runaway. The rule
// here is deliberately blunt: one exchange between a pair of agents, then a
// human must speak before that pair may continue.
//
// "Exchange" is defined pairwise and direction-insensitive: A→B then B→A is
// the one exchange, and the next agent-to-agent message in either direction is
// blocked until a human posts.
const MAX_AGENT_MESSAGES_PER_PAIR = 2;

function pairKey(x, y) {
  return [x, y].sort().join("|");
}

export class LoopGuard {
  #counts = new Map();

  // A human posting anywhere in the room clears every pair's budget: the
  // conversation has a person in it again.
  humanSpoke() {
    this.#counts.clear();
  }

  allow({ from, to }) {
    const key = pairKey(from, to);
    const used = this.#counts.get(key) ?? 0;
    if (used >= MAX_AGENT_MESSAGES_PER_PAIR) {
      return {
        allowed: false,
        reason: "agent-to-agent exchange limit reached — a human must speak next",
      };
    }
    this.#counts.set(key, used + 1);
    return { allowed: true };
  }
}
