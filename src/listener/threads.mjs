// Where a message sits in a thread, and where a reply to it belongs (AC-50,
// DD-42).
//
// ── Why the node has to answer this at all ─────────────────────────────────
//
// The agent does not pick its own thread. buzz-acp resolves a `--reply-to`
// anchor for every human-facing turn and hands it to the model in the
// `[Context]` block (`crates/buzz-acp/src/queue.rs::resolve_reply_anchor`,
// buzz @ a2d8be5ef):
//
//     thread_tags.root_event_id.unwrap_or(triggering_event_id)
//
// The triggering event for a RELAYED turn is the node's own wake. So when the
// node publishes a wake at the channel root, the harness dutifully anchors the
// agent's reply to that wake — and a question asked inside a thread is answered
// in a new thread hanging off a machine's relay message. That is the split
// AC-50 forbids, and no instruction to the model can fix it, because the model
// is following the anchor it was given.
//
// Thread the WAKE to the trigger's own thread root and the harness computes the
// right anchor by itself. The agent's reply lands where the human asked with no
// cooperation from the model required, which is the only kind of threading that
// survives a model having an off day.
//
// ── The rules are upstream's, deliberately ─────────────────────────────────
//
// `crates/buzz-core/src/nip10.rs` is the ONE resolver the relay's ingest and
// ACP's anchoring both call — it exists because two hand-rolled copies had
// already drifted on marker semantics and id validity. This is a third reader
// of the same wire format, so it copies that file's rules rather than inventing
// compatible-looking ones: hive402's idea of a thread being one step out of
// step with the relay's is worse than not threading at all.

// A marker counts only when its event id is exactly 64 ASCII-hex characters.
// A malformed id is ignored, never treated as a thread link.
const EVENT_ID_RE = /^[0-9a-fA-F]{64}$/;

// The `root` / `reply` markers on an event's `e` tags. Last valid occurrence of
// each wins, matching the relay resolver's single-pass overwrite.
function threadMarkers(tags) {
  const markers = { root: null, reply: null };
  for (const tag of Array.isArray(tags) ? tags : []) {
    // `parts.len() >= 4 && parts[0] == "e"` — a marker element is required, so
    // a bare `["e", id]` reference is not a thread link.
    if (!Array.isArray(tag) || tag.length < 4) continue;
    if (tag[0] !== "e") continue;
    const id = tag[1];
    if (typeof id !== "string" || !EVENT_ID_RE.test(id)) continue;
    if (tag[3] === "root") markers.root = id;
    else if (tag[3] === "reply") markers.reply = id;
  }
  return markers;
}

// The root of the thread this event sits IN, or null when it is top-level.
//
// The collapse rule is `ThreadMarkers::resolve`:
//   root + reply -> root      a nested reply names both
//   reply only   -> reply     a direct reply to the root; the target IS the root
//   root only    -> null      top-level — a lone root tag never anchors a reply
//   neither      -> null      top-level
//
// The `root only` case is the one that reads backwards and is therefore the one
// to get wrong: ACP was corrected to match ingest on exactly this point.
export function threadRootOf(event) {
  const { root, reply } = threadMarkers(event?.tags);
  if (reply) return root ?? reply;
  return null;
}

// Where a reply to this event belongs.
//
// Already in a thread → that thread's root, which keeps a human-facing reply
// flat at layer 1 rather than nesting one deeper on every hop. Top-level → the
// event itself, so the answer attaches to the question and opens its thread
// there. Both halves are upstream's own rule for a human-facing turn, and the
// second is the one that matters most here: anchoring on nothing is what lets
// the harness anchor the agent on the node's relay message instead.
export function replyAnchor(event) {
  return threadRootOf(event) ?? event?.id ?? null;
}

// The message this event was written AS A REPLY TO — the NIP-10 `reply`
// marker, in both shapes the CLI emits (`["e", root, "", "root"]` +
// `["e", parent, "", "reply"]` nested; a single `reply` tag for a direct
// reply). This is how a taken-message notice pins the SPECIFIC message it
// promised (F-11, DD-54): the notice is sent with `--reply-to <trigger>`, the
// CLI derives the root itself, and the trigger survives here as the reply
// marker for the replay pass to read back.
export function replyTargetOf(event) {
  return threadMarkers(event?.tags).reply;
}
