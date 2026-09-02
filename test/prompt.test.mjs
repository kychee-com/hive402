import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { readSecret } from "../src/credentials/prompt.mjs";

// A stand-in for a raw-mode TTY. The real one delivers whatever the terminal
// hands it: a keystroke is one chunk, but a PASTE is one chunk containing the
// whole string — which is exactly how a naive "switch on the chunk" reader
// silently drops the Enter at the end of a pasted key.
function fakeTty() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = (on) => {
    stdin.rawMode = on;
    stdin.rawModeCalls = (stdin.rawModeCalls ?? 0) + 1;
  };
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};

  const written = [];
  const stdout = { write: (s) => written.push(s) };
  return { stdin, stdout, written };
}

test("a pasted key arriving as one chunk is read whole", async () => {
  const { stdin, stdout } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Key: " });
  stdin.emit("data", "abc123\r");
  assert.equal(await pending, "abc123");
});

test("typed characters accumulate across chunks", async () => {
  const { stdin, stdout } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Key: " });
  for (const ch of "dead") stdin.emit("data", ch);
  stdin.emit("data", "\n");
  assert.equal(await pending, "dead");
});

// The whole point of the prompt: the key must not appear on screen, so it
// cannot be read off a shoulder, a screen share, or a terminal recording.
test("nothing typed is ever echoed", async () => {
  const { stdin, stdout, written } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Key: " });
  stdin.emit("data", "s3cr3t-value\r");
  await pending;

  const screen = written.join("");
  assert.ok(screen.includes("Key: "), "the prompt itself is printed");
  assert.ok(!screen.includes("s3cr3t-value"), "the secret must never be written to the terminal");
});

test("backspace erases the last character", async () => {
  const { stdin, stdout } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Key: " });
  stdin.emit("data", "abx");
  stdin.emit("data", "");
  stdin.emit("data", "c\r");
  assert.equal(await pending, "abc");
});

test("CRLF terminates once, not twice", async () => {
  const { stdin, stdout } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Key: " });
  stdin.emit("data", "value\r\n");
  assert.equal(await pending, "value");
});

test("Ctrl-C cancels instead of returning a partial key", async () => {
  const { stdin, stdout } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Key: " });
  stdin.emit("data", "half");
  stdin.emit("data", "");
  await assert.rejects(() => pending, /cancel/i);
});

// Leaving the terminal in raw mode after the command exits makes the operator's
// shell stop echoing anything at all — a memorably bad way to end a command
// that was about to tell them their pubkey.
test("raw mode is always turned back off, on success and on cancel", async () => {
  for (const ending of ["\r", ""]) {
    const { stdin, stdout } = fakeTty();
    const pending = readSecret({ input: stdin, output: stdout, prompt: "Key: " });
    stdin.emit("data", "x");
    stdin.emit("data", ending);
    await pending.catch(() => {});
    assert.equal(stdin.rawMode, false, `raw mode left on after ${JSON.stringify(ending)}`);
  }
});

test("a non-TTY stdin still works, for a piped key in CI", async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = false;
  stdin.setEncoding = () => {};
  stdin.resume = () => {};
  const written = [];

  const pending = readSecret({ input: stdin, output: { write: (s) => written.push(s) }, prompt: "Key: " });
  stdin.emit("data", "piped-key\n");
  stdin.emit("end");

  assert.equal(await pending, "piped-key");
  // No TTY means no interactive prompt to draw — printing one into a pipe just
  // corrupts whatever is reading the output.
  assert.ok(!written.join("").includes("Key: "));
});

// --- F-022 (fix cycle 13): the real interactive paste, end to end -----------
//
// The thing an owner actually does: copy the nsec off Buzz's backup screen and
// paste it at this prompt. That is 63 characters arriving as ONE raw-mode chunk
// with the Enter on the end, which is the exact shape this module was written
// for — so it is worth proving with the real string rather than "abc123".

test("a pasted nsec is read whole, unechoed, and imports (F-022)", async () => {
  const { hexToBech32 } = await import("../fixtures/bech32-encode.mjs");
  const { importPrivateKey, derivePubkey, generateSecretKey } = await import(
    "../src/credentials/keys.mjs"
  );
  const { CredentialStore } = await import("../src/credentials/store.mjs");

  const hex = generateSecretKey();
  const nsec = hexToBech32("nsec", hex);
  assert.equal(nsec.length, 63, "a NIP-19 nsec is 63 characters");

  const { stdin, stdout, written } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Paste: " });
  stdin.emit("data", `${nsec}\r`); // one chunk, as a terminal delivers a paste
  const typed = await pending;
  assert.equal(typed, nsec, "the whole nsec, with the Enter stripped");

  const screen = written.join("");
  assert.ok(!screen.includes(nsec), "the nsec must never reach the terminal");
  assert.ok(!screen.includes(hex), "and neither must the key behind it");

  // And the string the prompt produced is the string the importer accepts —
  // the join between the two halves, which neither test covers alone.
  const vault = new Map();
  const store = new CredentialStore({
    keychain: {
      async set(s, a, v) { vault.set(`${s}:${a}`, v); },
      async create(s, a, v) { vault.set(`${s}:${a}`, v); },
      async get(s, a) { return vault.get(`${s}:${a}`) ?? null; },
      async remove(s, a) { return vault.delete(`${s}:${a}`); },
    },
  });
  const result = await importPrivateKey({
    store,
    target: { kind: "agent", name: "pasted" },
    log: () => {},
    readSecret: async () => typed,
  });
  assert.equal(result.pubkey, derivePubkey(hex));
  assert.equal(await store.getAgentPrivateKey("pasted"), hex);
});

test("a pasted nsec split across two chunks still reads whole (F-022)", async () => {
  // A long paste over a slow pipe or an ssh session can arrive in pieces, and
  // 63 characters is long enough for it to happen.
  const { hexToBech32 } = await import("../fixtures/bech32-encode.mjs");
  const nsec = hexToBech32("nsec", "11".repeat(32));

  const { stdin, stdout } = fakeTty();
  const pending = readSecret({ input: stdin, output: stdout, prompt: "Paste: " });
  stdin.emit("data", nsec.slice(0, 30));
  stdin.emit("data", nsec.slice(30));
  stdin.emit("data", "\r");
  assert.equal(await pending, nsec);
});
