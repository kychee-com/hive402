// A bech32 ENCODER, for tests only. Deliberately not in `src/`.
//
// Nothing in hive402 needs to encode: keys go IN as nsec or hex and are stored
// as hex, and there is no command that shows a key, by design. An exported
// encoder in `src/` would therefore be a module with no caller, which is this
// project's most-repeated bug (the invented attestation format,
// `LoopGuard.allow()`, the whole cycle-1 policy layer) and which
// `test/reachability.test.mjs` exists to catch.
//
// It is also written out independently of `src/credentials/bech32.mjs` rather
// than sharing its polymod. A round trip through one implementation proves the
// implementation is self-consistent; a round trip through two proves it is
// right. That distinction found two transcription errors in the BIP-173 vectors
// while this was being written.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < GENERATORS.length; i += 1) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const ch of hrp) out.push(ch.charCodeAt(0) >>> 5);
  out.push(0);
  for (const ch of hrp) out.push(ch.charCodeAt(0) & 31);
  return out;
}

/** Encode 5-bit words under a human-readable part. */
export function encodeBech32(hrp, words) {
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i += 1) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** Bytes to 5-bit words, zero-padded, the canonical direction. */
export function bytesToWords(bytes) {
  let acc = 0;
  let bits = 0;
  const words = [];
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

export const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
export const bytesToHex = (bytes) => Buffer.from(bytes).toString("hex");

/** The whole job in one call: 64-char hex to `nsec1…` / `npub1…`. */
export const hexToBech32 = (hrp, hex) => encodeBech32(hrp, bytesToWords(hexToBytes(hex)));

/** Flip one character of a bech32 string, so the checksum must catch it. */
export function corrupt(written, index = written.length - 3) {
  const ch = written[index];
  return `${written.slice(0, index)}${ch === "q" ? "p" : "q"}${written.slice(index + 1)}`;
}
