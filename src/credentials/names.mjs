// What a hive402 identity may be called — in ONE place, because three layers
// have to agree about it (DD-30).
//
// The OS credential store derives a FILE NAME from the identity name. Until fix
// cycle 8, nothing capped it: a 300-character `--agent` name pushed
// `%LOCALAPPDATA%\hive402\credentials\<service>--<name>.dpapi` past Windows'
// 260-character MAX_PATH, the write threw, and the error handler printed the
// freshly generated private key (F-014). The error path is fixed separately and
// properly, but a failure that cannot happen is better than a failure that
// cannot leak — so a name that could never be stored is refused BEFORE a key is
// generated for it.
//
// The charset is not a coincidence: it is exactly what the Windows backend's
// filename sanitizer preserves. Matching them makes name-to-file injective,
// which closes a collision nobody had reported — `a:b` and `a_b` both sanitized
// to `a_b`, so one agent could silently overwrite another's key.
//
// Three callers, deliberately:
//   src/credentials/keys.mjs   refuses before `generate()` is ever called
//   src/credentials/store.mjs  the security boundary, for every caller
//   src/config/schema.mjs      so a config cannot name an agent the store will
//                              later refuse, which would surface as a baffling
//                              "no key" at `up` rather than as a config error

import { NOT_PRINTED, looksLikeKeyMaterial, looksLikePublicKeyMaterial } from "./refusal.mjs";

export const IDENTITY_NAME_MAX = 64;
export const IDENTITY_NAME_CHARSET = /^[A-Za-z0-9._-]+$/;

// Never echo the whole thing back: the input that found this bug was 300
// characters of filler, and an error that repeats it is unreadable.
function show(name) {
  return name.length <= 24 ? name : `${name.slice(0, 24)}…`;
}

// Returns the trimmed name, case preserved — the store lowercases for storage,
// but an operator should see the name they typed.
export function assertIdentityName(value, what = "agent name") {
  const name = String(value ?? "").trim();

  if (name === "") throw new Error(`an ${what} is required`);

  // A name is not a secret field — but `--agent` sits on the same command line
  // as the key commands, and an identity name is printed straight back by
  // `keygen`, `keys list`, `doctor` and the `register` line this CLI tells you
  // to run. So key material pasted here reaches a printable sink by the front
  // door, with no error needed at all (DD-31, the F-016 class). 64 hex
  // characters is both a valid key and — until this check — exactly the cap and
  // exactly the charset, so it was a legal name.
  if (looksLikeKeyMaterial(name)) {
    throw new Error(
      `that ${what} is a private KEY, not a name. An identity name is printed back by ` +
        `"keygen", "keys list" and "doctor", so hive402 will not accept one. ${NOT_PRINTED}`,
    );
  }

  // A PUBLIC key is safe to print, so this is not the disclosure above — it is
  // the wrong-field mistake, found by the F-022 sweep (fix cycle 13). Since
  // `npub1…` became a legal value for `pubkey`, someone copying two values out
  // of Buzz can put the same one in both places, and an npub is a perfectly
  // legal agent name under the charset and the 64-character cap. The result is
  // a room where an agent is addressed by its own public key, which nobody
  // intends and nothing else would have questioned.
  if (looksLikePublicKeyMaterial(name)) {
    throw new Error(
      `that ${what} is a PUBLIC key (npub1…), not a name. It belongs in the "pubkey" field; ` +
        `the name is what people type to address this identity in the room.`,
    );
  }

  if (name.length > IDENTITY_NAME_MAX) {
    // By length, not by value: this is exactly the branch a pasted 65-character
    // near-key lands in, and the length was always the useful half (DD-31).
    throw new Error(
      `${what} is too long: ${name.length} characters, and the limit is ${IDENTITY_NAME_MAX}. ` +
        `The OS credential store derives a file name from it, and a longer one cannot be ` +
        `written. ${NOT_PRINTED}`,
    );
  }

  if (!IDENTITY_NAME_CHARSET.test(name)) {
    throw new Error(
      `${what} "${show(name)}" may contain only letters, digits, dot, dash and underscore. ` +
        `Anything else has to be rewritten to become a file name, which would quietly ` +
        `change which identity you are talking about.`,
    );
  }

  return name;
}
