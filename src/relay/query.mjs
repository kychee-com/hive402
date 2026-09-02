// The relay's HTTP query door (F-11, spike S30-3).
//
// `POST /query` takes a JSON ARRAY of Nostr filters and answers with an array
// of events (buzz `origin/main` c856be0fb, `router.rs:73` →
// `api::bridge::query_events`). NIP-98-signed over the exact method, URL and
// body, membership-enforced on the relay side — the same door, and the same
// auth pattern, as the 30177 publish in `managedagent.mjs`.
//
// The cover path reads three things through here, all with plain filters:
// the managed-agent registry (`kinds:[30177]`), the promised-message search
// (`kinds:[9]` by author and channel), and a single old message by id
// (`ids:[…]`) when the recent window no longer holds it.

// The write half of the same door: `POST /events` submits one pre-signed
// event, NIP-98-signed over the exact URL and body — the route the node
// already uses for its 30177 records, now shared by the liveness beat
// (AC-60). The EVENT is signed by its author's key; the HEADER may be signed
// by whoever is submitting (here: the same identity).
export async function submitEvent({
  origin,
  event,
  privateKeyHex,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  nip98,
}) {
  const url = `${String(origin).replace(/\/$/, "")}/events`;
  const body = JSON.stringify(event);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98({ privateKeyHex, url, method: "POST", body, now }),
    },
    body,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      detail = payload?.error ?? payload?.message ?? detail;
    } catch {
      /* the status is what we have */
    }
    throw new Error(`the relay refused the event (${detail})`);
  }
  return { published: true };
}

export async function queryEvents({
  origin,
  filters,
  privateKeyHex,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  nip98,
}) {
  const url = `${String(origin).replace(/\/$/, "")}/query`;
  const body = JSON.stringify(filters);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98({ privateKeyHex, url, method: "POST", body, now }),
    },
    body,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      detail = payload?.error ?? payload?.message ?? detail;
    } catch {
      /* the status is what we have */
    }
    throw new Error(`the relay refused the query (${detail})`);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}
