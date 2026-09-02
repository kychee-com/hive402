import { test } from "node:test";
import assert from "node:assert/strict";

import { BuzzCli, cliRelayUrl } from "../src/relay/buzzcli.mjs";

const SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

// Records what the CLI would have been called with, and replays a canned reply.
function recorder(reply = "{}") {
  const calls = [];
  const run = async ({ args, env }) => {
    calls.push({ args, env });
    const out = typeof reply === "function" ? reply(args) : reply;
    return { stdout: out, stderr: "", code: 0 };
  };
  return { calls, run };
}

const cli = (run, extra = {}) =>
  new BuzzCli({ binPath: "buzz.exe", relayUrl: "ws://localhost:3000", privateKey: SK, run, ...extra });

// The harness (buzz-acp) demands ws://; the CLI (buzz.exe) demands http://.
// Same relay, two spellings — the node holds one config value and each consumer
// gets the form it accepts. Getting this wrong fails at connect time, well
// after startup looks healthy.
test("the websocket relay url is translated to the http form the CLI wants", () => {
  assert.equal(cliRelayUrl("ws://localhost:3000"), "http://localhost:3000");
  assert.equal(cliRelayUrl("wss://relay.example.com"), "https://relay.example.com");
  assert.equal(cliRelayUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(cliRelayUrl("https://relay.example.com"), "https://relay.example.com");
});

test("every CLI call carries the identity env, and the relay in http form", async () => {
  const { calls, run } = recorder("[]");
  await cli(run).getMessages({ channel: CHANNEL });
  assert.equal(calls[0].env.BUZZ_PRIVATE_KEY, SK);
  assert.equal(calls[0].env.BUZZ_RELAY_URL, "http://localhost:3000");
});

test("an owner attestation is injected into every event the identity signs", async () => {
  const authTag = ["auth", "aa".repeat(32), "", "bb".repeat(64)];
  const { calls, run } = recorder("[]");
  await cli(run, { authTag }).getMessages({ channel: CHANNEL });
  assert.equal(calls[0].env.BUZZ_AUTH_TAG, JSON.stringify(authTag));
});

test("no attestation means no BUZZ_AUTH_TAG at all, not an empty one", async () => {
  // buzz.exe rejects a malformed BUZZ_AUTH_TAG outright, so a blank value would
  // break every call made by a plain human identity.
  const { calls, run } = recorder("[]");
  await cli(run).getMessages({ channel: CHANNEL });
  assert.ok(!("BUZZ_AUTH_TAG" in calls[0].env));
});

test("sending with mentions emits one --mention per pubkey", async () => {
  const { calls, run } = recorder('{"accepted":true,"event_id":"abc"}');
  await cli(run).send({ channel: CHANNEL, content: "hi", mentions: [AGENT, "cc".repeat(32)] });
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 2), ["messages", "send"]);
  assert.equal(args.filter((a) => a === "--mention").length, 2);
  assert.ok(args.includes(AGENT));
});

test("a send with no mentions passes no --mention flag", async () => {
  const { calls, run } = recorder('{"accepted":true}');
  await cli(run).send({ channel: CHANNEL, content: "hi" });
  assert.ok(!calls[0].args.includes("--mention"));
});

test("JSON output is parsed for the caller", async () => {
  const { run } = recorder('[{"id":"e1","kind":9,"content":"hello"}]');
  const events = await cli(run).getMessages({ channel: CHANNEL });
  assert.equal(events[0].content, "hello");
});

test("a CLI failure surfaces the relay's own error message, not a bare exit code", async () => {
  const run = async () => ({
    stdout: "",
    stderr: '{"error":"user_error","message":"mention \'@ghost\' does not match a current channel member"}',
    code: 1,
  });
  await assert.rejects(
    () => cli(run).send({ channel: CHANNEL, content: "@ghost hi" }),
    /does not match a current channel member/,
  );
});

test("setting a profile publishes the display name the room addresses", async () => {
  const { calls, run } = recorder('{"accepted":true}');
  await cli(run).setProfile({ name: "spike", about: "hive402 agent" });
  assert.deepEqual(calls[0].args.slice(0, 2), ["users", "set-profile"]);
  assert.ok(calls[0].args.includes("spike"));
});

test("a user lookup that finds nobody returns null rather than an empty array", async () => {
  const { run } = recorder("[]");
  assert.equal(await cli(run).getUser({ name: "ghost" }), null);
});

test("a user lookup returns the single matching profile", async () => {
  const { run } = recorder(`[{"pubkey":"${AGENT}","display_name":"spike"}]`);
  const user = await cli(run).getUser({ name: "spike" });
  assert.equal(user.pubkey, AGENT);
});
