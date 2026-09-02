import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readStatus } from "../src/node/runtime.mjs";
import { parseConfig, DEFAULT_MODEL } from "../src/config/schema.mjs";

// AC-76: the node reports which model each of its agents is running, and says
// whether that came from the agent or from the node.
//
// Without this the setting is invisible from outside the machine and AC-74/75
// could only ever be verified by reading source. It is also the AC-73
// principle applied one level down: a command says what it resolved.

const PK = (c) => c.repeat(64);

const configWith = ({ nodeModel, agentModel } = {}) =>
  parseConfig({
    relayUrl: "ws://localhost:3000",
    node: { pubkey: PK("9"), ...(nodeModel ? { model: nodeModel } : {}) },
    rooms: [
      {
        channel: "b86d8eda-5f05-496c-af45-ef4442ad5876",
        agents: [
          {
            name: "spike",
            pubkey: PK("4"),
            ownerPubkey: PK("7"),
            ...(agentModel ? { model: agentModel } : {}),
          },
        ],
      },
    ],
  });

const statusFor = async (over) =>
  readStatus({
    config: configWith(over),
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-modelreport-")),
    configFile: "C:/somewhere/hive402.config.json",
  });

const spikeOf = (status) => status.configuredAgents.find((a) => a.name === "spike");

test("status reports the model an agent runs on", async () => {
  const spike = spikeOf(await statusFor({ nodeModel: "claude-opus-5" }));
  assert.equal(spike.model, "claude-opus-5");
});

test("status says the model came from the NODE when the node named it", async () => {
  const spike = spikeOf(await statusFor({ nodeModel: "claude-opus-5" }));
  assert.equal(spike.modelSource, "node");
});

test("status says the model came from the AGENT when the agent named its own", async () => {
  const spike = spikeOf(
    await statusFor({ nodeModel: "claude-opus-5", agentModel: "claude-haiku-4-5-20251001" }),
  );
  assert.equal(spike.model, "claude-haiku-4-5-20251001");
  assert.equal(spike.modelSource, "agent");
});

test("status says DEFAULT when nobody named one — never null, never the machine's", async () => {
  const spike = spikeOf(await statusFor({}));
  assert.equal(spike.model, DEFAULT_MODEL);
  assert.equal(spike.modelSource, "default");
});

test("doctor tells the owner the same thing in prose", () => {
  // AC-73's principle one level down: a command says what it resolved. `status`
  // answers in JSON for machine callers; `doctor` is what a human reads.
  const body = readFileSync(new URL("../bin/cli.mjs", import.meta.url), "utf8");
  assert.match(
    body,
    /model for \$\{|model for \$\{agent\.name\}|runs on/,
    "doctor must name each agent's model",
  );
  assert.match(body, /modelSource|resolveModel/, "doctor must resolve the model to report it");
});
