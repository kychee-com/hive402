// "There is no key" has to be a finding, not a first impression (FIX-127).
//
// ── Why one look is not enough ─────────────────────────────────────────────
//
// Reading a key is a process spawn: PowerShell on Windows, `security` on macOS,
// `secret-tool` on Linux. `keychain.mjs` already says in its own comment that
// under load one occasionally does not come back, and it retries a REJECTED
// read once — immediately, with no gap, which against a transient means running
// straight back into whatever caused it.
//
// The gap that retry does not cover is the answer that is not a rejection.
// "Absent" comes back as a value (null), so it never enters the retry path at
// all. One flaky observation becomes a fact.
//
// ── What that fact then causes ─────────────────────────────────────────────
//
// The caller of a null is a command that offers to CREATE an identity. On
// 2026-08-26 that path ran by itself and minted a second node identity over a
// working one, which Barry found as an "Unnamed member" in his own community —
// a durable identity in somebody else's room that no local cleanup removes.
// `ABSENT_EXIT` stopped the automatic case. On 2026-08-27 the same wrong verdict
// came back and simply TOLD him to do it by hand: "create one: hive402 keygen
// --node", printed on a machine whose keys were both fine.
//
// So an absence is confirmed before it is believed. Two independent looks,
// spaced apart. The cost falls entirely on the path that is about to report
// nothing anyway; a key that is there is read once and returned.
//
// This does not make a flaky read impossible, and it is not claimed to: it makes
// a one-in-N transient into a one-in-N-squared one, on the specific answer whose
// consequence is a second identity. A read that FAILS still travels untouched,
// because that distinction is the whole of the earlier fix and this must not
// weaken it.

// Long enough that the second look is not the same moment as the first, short
// enough to be invisible on a start. Whatever caused the first spawn to fail is
// almost always over within a beat.
const CONFIRM_DELAY_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `read` returns the secret, or null for absent, and THROWS on failure. That
// contract is the one `keychain.get` already has, so this composes with it
// rather than reinterpreting it.
//
// Returns `{ absent, value }`. A throw from either look propagates: "I could not
// read it" must never quietly become "there is nothing there", which is the
// failure this whole area of the code exists to prevent.
export async function confirmedAbsent({ read, delay = sleep }) {
  const first = await read();
  if (first) return { absent: false, value: first };

  await delay(CONFIRM_DELAY_MS);

  const second = await read();
  if (second) return { absent: false, value: second };

  return { absent: true, value: null };
}
