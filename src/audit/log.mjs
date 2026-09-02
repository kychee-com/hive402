// AuditLog — append-only record of what agents did and who let them (AC-27).
//
// Covers actions, approvals AND settings changes: enabling `build` is the
// security-relevant moment, not merely the deploy that follows it.
// One JSON object per line so it stays greppable and can be tailed.

// Redact anything shaped like a credential before it reaches disk. The audit
// log is queryable from chat, so a leaked token here would be worse than not
// logging at all.
const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})/g,           // Anthropic / OpenAI style
  /\b(ghp_[A-Za-z0-9]{8,})/g,            // GitHub PAT
  /\bnsec1[0-9a-z]{20,}/g,               // Nostr secret key (bech32)
  /\b([0-9a-f]{64})\b/g,                 // bare 64-hex (could be a private key)
];

// Exported because the tool gate (src/runtime/toolgate.mjs) writes to this same
// log from inside the agent's runtime, in a different process, and must apply
// the identical rule. Two writers, one redaction.
export function redact(value) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

export class AuditLog {
  #sink;
  #source;
  #now;
  #entries = [];

  // `source` makes the LOG FILE the record, rather than this object's memory.
  //
  // That matters since fix cycle 2: the tool gate (src/runtime/toolgate.mjs)
  // runs inside the agent's runtime, in a different process, and appends its
  // own entries for every action tool it sees. Those are the entries that catch
  // what the node's own classifier missed — which is the entire point of DD-16 —
  // so a query that only returns what this process remembers would reproduce
  // F-007's blind spot in the very place built to reveal it.
  constructor({ sink, source = null, now = () => Date.now() } = {}) {
    this.#sink = sink;
    this.#source = source;
    this.#now = now;
  }

  #write(entry) {
    const safe = Object.fromEntries(
      Object.entries(entry).map(([k, v]) => [k, redact(v)]),
    );
    safe.at = this.#now();
    this.#entries.push(safe);
    this.#sink?.append(JSON.stringify(safe));
    return safe;
  }

  action({ agent, actor, kind, detail }) {
    return this.#write({ type: "action", agent, actor, kind, detail });
  }

  approval({ agent, approver, proposalId, granted }) {
    return this.#write({ type: "approval", agent, approver, proposalId, granted });
  }

  settingsChange({ agent, actor, setting, from, to }) {
    return this.#write({ type: "settings_change", agent, actor, setting, from, to });
  }

  // Every entry on the record, from every writer. A line we cannot parse is
  // skipped rather than allowed to take the query down: a corrupt tail must not
  // make the audit log unreadable at exactly the moment someone needs it.
  #all() {
    if (!this.#source) return this.#entries;
    const rows = [];
    for (const line of this.#source.read() ?? []) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return rows;
  }

  // Newest first — a chat query wants the most recent activity.
  query({ agent, type, limit } = {}) {
    let rows = [...this.#all()].reverse();
    if (agent) rows = rows.filter((r) => r.agent === agent);
    if (type) rows = rows.filter((r) => r.type === type);
    return typeof limit === "number" ? rows.slice(0, limit) : rows;
  }
}
