// hive402 node configuration.
//
// The owner-facing surface is deliberately six settings (spec AC-18): name,
// replyMode, crossOwnerAsks, selfInitiated, research, build. Anything else is
// rejected rather than ignored, so a typo can never silently leave an agent on
// a default the owner didn't choose.

import { assertIdentityName } from "../credentials/names.mjs";
import { KEY_REFERENCE, NOT_PRINTED, describeRefusedValue, looksLikeKeyMaterial } from "../credentials/refusal.mjs";
import { explainKeyRefusal, normalizePublicKey } from "../credentials/keyforms.mjs";

export const DEFAULT_AGENT_SETTINGS = {
  replyMode: "well-mannered",
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  research: false, // newcomers start with capabilities off (AC-22)
  build: false,
};

// The model an agent runs on (AC-74/AC-75, DD-62).
//
// hive402 used to have no say in this at all. The launcher passes USERPROFILE
// and APPDATA so an agent can find its owner's login (AC-3), the ACP adapter
// starts Claude Code, and Claude Code reads the OWNER'S OWN settings.json — so
// one line in a personal config decided what every hosted agent on the machine
// ran, and two hives on one machine could not differ. That is the coupling
// this field removes.
//
// The default is hive402's own, deliberately NOT "whatever the machine says":
// a fallback to the owner's personal setting would make the whole field
// cosmetic. Sonnet because hosted agents answer short messages in a room, and
// a default nobody thinks about should be the cheap one (Barry, 2026-08-31).
export const DEFAULT_MODEL = "claude-sonnet-5";

// A blank model is not a choice. Left storable it would make "named nothing"
// ambiguous, and the agent would die at its first turn instead of here, next
// to the typo. Names are NOT validated against a list of known models: that
// list would go stale the day a new model ships, and a wrong name already
// surfaces through AC-57's failed-turn report.
function parseModel(raw, label) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${label}: model must be a non-empty string naming a model, e.g. "${DEFAULT_MODEL}"`);
  }
  return raw.trim();
}

// agent → node → the default hive402 ships with. The source travels with the
// value because AC-76 requires the node to say where the answer came from; an
// owner debugging a surprising bill needs to know which of the three rungs
// answered.
export function resolveModel(agent, node) {
  if (agent?.model) return { model: agent.model, source: "agent" };
  if (node?.model) return { model: node.model, source: "node" };
  return { model: DEFAULT_MODEL, source: "default" };
}

const ENUMS = {
  replyMode: ["well-mannered", "addressed-only"],
  crossOwnerAsks: ["owner-approves", "auto-allow", "deny"],
  selfInitiated: ["asks-owner", "any-human", "deny"],
};

const BOOLEANS = ["research", "build"];
const HEX64 = /^[0-9a-f]{64}$/i;

// A key reference names WHERE a key lives; it is never the key. The pattern
// itself lives in credentials/refusal.mjs so the runtime RESOLVER decides the
// same thing this parser does — they disagreed until fix cycle 9, and the
// looser one was reachable (DD-31).
const KEY_REF = KEY_REFERENCE;

// A `privateKeyRef` names WHERE a key lives and sits in the config right beside
// the place a key would be pasted, so pasting one into it is the obvious slip —
// and the refusal travels to terminal scrollback, CI logs and pasted bug
// reports. Neither branch below echoes the value (DD-31): the recognised-key
// branch exists only because "that is a KEY, import it" is better ADVICE, not
// because it is the only safe one.
//
// Fix cycle 8 had it the other way round — it redacted what it recognised and
// echoed everything else — so a key one character short or long of 64 printed
// verbatim (F-016). Recognising the secret is a denylist over an infinite input
// space; the default has to be silence.
function refuseKeyRef(label, value) {
  if (looksLikeKeyMaterial(value)) {
    return new Error(
      `${label}: that is a private KEY, not a reference to one. privateKeyRef must be ` +
        `"keychain" or "env:VAR_NAME" — store the key with "hive402 keys import" and leave ` +
        `this as "keychain", or point it at an env var. ${NOT_PRINTED}`,
    );
  }
  return new Error(
    `${label}: privateKeyRef must be "keychain" or "env:VAR_NAME" — got ` +
      `${describeRefusedValue(value)}, which is neither. It names where the key lives, ` +
      `it is never the key itself. ${NOT_PRINTED}`,
  );
}

// A PUBLIC key, in either form it is written (F-022, DD-40). Someone filling in
// this file is copying from Buzz, and Buzz shows them an `npub1…`; telling them
// to convert it by hand is the same wall `keys import` used to put in front of
// the private one. `buzz-admin` itself takes "a bech32 npub or 64-char hex
// pubkey" and normalises to hex, so this matches the ecosystem rather than
// diverging from it.
//
// The refusal is the interesting half. A plain typo keeps the old, direct
// sentence — it is the most common case and "must be 64-char hex" is exactly
// what the reader needs. Everything recognisable gets a specific one, and the
// specific one that matters is an `nsec1…`: that is a live private key sitting
// in a plaintext config file, which the old generic message said nothing about.
// No branch echoes the value or anything decoded from it (DD-31, F-016).
function acceptPublicKey(value, label, field, note) {
  const given = normalizePublicKey(value);
  if (given.ok) return given.hex;

  if (given.reason === "empty" || given.reason === "unrecognised") {
    throw new Error(`${label}: ${field} must be 64-char hex or an npub1…${note}`);
  }
  const described = describeRefusedValue(typeof value === "string" ? value.trim() : value);
  throw new Error(
    `${label}: ${field} — ${explainKeyRefusal({ reason: given.reason, described, kind: "public" })}`,
  );
}

// An agent's durable character (AC-55, DD-45): free text inline, or a path to
// it for anything longer than a sentence.
//
// Validation only — the FILE is not read here. `parseConfig` stays pure so it
// can be re-run to validate an edit before it is written (see `setSetting`),
// and a path is meaningless without the config file's own directory to resolve
// it against, which the parser does not know. `resolveInstructions` in
// launcher/instructions.mjs does the reading.
function parseInstructions(raw, name) {
  const has = (v) => v !== undefined && v !== null;
  if (has(raw.instructions) && has(raw.instructionsFile)) {
    throw new Error(
      `agent "${name}": set instructions OR instructionsFile, not both — hive402 will not ` +
        `guess which one describes the agent`,
    );
  }
  for (const field of ["instructions", "instructionsFile"]) {
    if (!has(raw[field])) continue;
    if (typeof raw[field] !== "string") {
      throw new Error(`agent "${name}": ${field} must be a string`);
    }
    if (!raw[field].trim()) {
      throw new Error(
        `agent "${name}": ${field} is empty. Remove the field to give ${name} no instructions; ` +
          `an empty one is a half-finished edit.`,
      );
    }
  }
  return {
    instructions: has(raw.instructions) ? raw.instructions.trim() : null,
    instructionsFile: has(raw.instructionsFile) ? raw.instructionsFile.trim() : null,
  };
}

// An agent's picture. Other people's clients fetch this URL, so a relative path
// or a local file name publishes a broken `picture` to the whole room and
// nothing on this machine would ever see it fail.
//
// MEASURED ON A REAL COMMUNITY (2026-08-26): every member with a working
// picture — a human owner, a human member, AND another node's bot — has it
// hosted in the RELAY's own Blossom media store, at
// `https://<relay>/media/<sha256>.png`. Those URLs 404 without auth, so the
// client fetches them as an authenticated member. An arbitrary external URL is
// accepted here and may well work, but nothing in that room is evidence that
// it does, so the error below names the route that is known to.
function parseAvatar(raw, name) {
  if (raw === undefined || raw === null || raw === "") return null;
  // ONE message for both ways of getting this wrong, because they are the same
  // mistake. `C:/pics/spike.png` does not fail to parse — it parses as a URL
  // with the protocol `c:` — so a Windows path lands in the protocol branch and
  // a POSIX one in the parse branch, and a reader who saw only "invalid
  // protocol" would have no idea what was wanted.
  const refuse = () =>
    new Error(
      `agent "${name}": avatar must be a full http(s) URL, not a file path.\n` +
        `  Upload the image to your community first and use the URL it returns:\n` +
        `    buzz upload file --file <path-to-image.png>\n` +
        `  That is where every working picture in a Buzz room is hosted.`,
    );

  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw refuse();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw refuse();
  return url.toString();
}

function parseAgent(raw, seenNames) {
  if (!raw || typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new Error("each agent needs a name");
  }
  const name = raw.name.trim();
  // The OS credential store derives a FILE NAME from this, and `privateKeyRef`
  // defaults to "keychain", so a config may not name an agent something the
  // store will later refuse (DD-30). Failing HERE, at load, turns what would be
  // a baffling "no key for X" at `up` into a config error next to the typo.
  assertIdentityName(name);
  const key = name.toLowerCase();
  if (seenNames.has(key)) {
    throw new Error(`duplicate agent name "${name}" — names must be unique per room`);
  }
  seenNames.add(key);

  // Normalised to hex HERE, before any comparison below (F-022, DD-40). An
  // `npub1…` and its own hex are the same identity, and every check that
  // follows — self-attestation, the duplicate-pubkey scan, the node-collision
  // scan — exists precisely to catch one identity appearing twice. Normalising
  // afterwards would have let the two written forms slip past all three.
  const ownerPubkey = acceptPublicKey(raw.ownerPubkey, `agent "${name}"`, "ownerPubkey", "");
  const pubkey = acceptPublicKey(
    raw.pubkey,
    `agent "${name}"`,
    "pubkey",
    " (the agent's own identity)",
  );
  if (pubkey === ownerPubkey) {
    throw new Error(`agent "${name}": an agent may not be its own owner (self-attestation)`);
  }

  // `pubkey`/`ownerPubkey` are identity, not settings — AC-18's "exactly six"
  // is about the owner-facing knobs, which are the DEFAULT_AGENT_SETTINGS keys
  // plus `name`. Anything outside this set is still refused.
  //
  // `instructions` / `instructionsFile` are owner-editable configuration but
  // deliberately NOT among the six (AC-18 says so in as many words): the six
  // are a closed set of switches with defined values, and instructions are free
  // text describing who the agent is. Putting them in DEFAULT_AGENT_SETTINGS
  // would make them a seventh switch and would list them as one in the "unknown
  // setting" message.
  // `avatar` is presentation, on the same footing as `instructions`: owner-set
  // configuration, not a seventh switch.
  //
  // FOUND BY LOOKING AT THE ROOM (Barry, 2026-08-25): a hive402 agent showed
  // with no picture while a human member showed with theirs. AC-46 had this
  // filed as "whether a client renders a picture hive402 publishes is
  // unverified" — but rendering was never the question. hive402 simply never
  // published one: `IdentityPublisher` sent `{name, about}` and there was no
  // field here to put a picture in. A human's picture rendering in the same
  // room is the proof the client side works.
  const allowed = new Set([
    "name",
    "pubkey",
    "ownerPubkey",
    "privateKeyRef", // where the agent's key lives — never the key itself
    "instructions",
    "instructionsFile",
    "avatar",
    // Lifecycle state, not a seventh switch (AC-18's six are a closed set of
    // behaviour settings; this says whether the agent exists in the room at
    // all). Written by `hive402 retire` — see AC-70 and DD-60.
    "retired",
    // Which model this agent runs on (AC-75). Like `retired`, not a seventh
    // switch: AC-18's six are behaviour settings with presets, and this is a
    // hosting property — see DD-62.
    "model",
    ...Object.keys(DEFAULT_AGENT_SETTINGS),
  ]);
  for (const banned of ["privateKey", "secretKey", "nsec", "sk"]) {
    if (raw[banned] !== undefined) {
      throw new Error(
        `agent "${name}": a private key must never live in the config file — ` +
          `use privateKeyRef: "keychain" or "env:VAR_NAME"`,
      );
    }
  }
  if (raw.privateKeyRef !== undefined && !KEY_REF.test(raw.privateKeyRef)) {
    throw refuseKeyRef(`agent "${name}"`, raw.privateKeyRef);
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(`agent "${name}": unknown setting "${key}"`);
    }
  }

  const agent = {
    name,
    pubkey,
    ownerPubkey,
    privateKeyRef: raw.privateKeyRef ?? "keychain",
    avatar: parseAvatar(raw.avatar, name),
    ...parseInstructions(raw, name),
    ...DEFAULT_AGENT_SETTINGS,
  };

  for (const [setting, values] of Object.entries(ENUMS)) {
    if (raw[setting] !== undefined) {
      if (!values.includes(raw[setting])) {
        throw new Error(
          `agent "${name}": ${setting} must be one of ${values.join(", ")} (got "${raw[setting]}")`,
        );
      }
      agent[setting] = raw[setting];
    }
  }

  for (const setting of BOOLEANS) {
    if (raw[setting] !== undefined) {
      if (typeof raw[setting] !== "boolean") {
        throw new Error(`agent "${name}": ${setting} must be true or false`);
      }
      agent[setting] = raw[setting];
    }
  }

  // Retired (AC-70). Set only when true, so a live agent's parsed shape is
  // byte-for-byte what it has always been — a truthiness check somewhere in the
  // tree must never start seeing a new field on the ordinary path.
  if (raw.retired !== undefined) {
    if (typeof raw.retired !== "boolean") {
      throw new Error(
        `agent "${name}": retired must be true or false — a string here would leave a retired agent ` +
          `running, or a live one silently gone`,
      );
    }
    if (raw.retired) agent.retired = true;
  }

  {
    // Absent means "run on my node's", so the key stays off the object rather
    // than being defaulted here — the resolver owns the fallback.
    const model = parseModel(raw.model, `agent "${name}"`);
    if (model !== undefined) agent.model = model;
  }

  return agent;
}

// The node's own identity. It publishes wakes, posts approval asks and answers
// /audit under this key, so it is a first-class member of the room and must be
// distinct from every agent it hosts.
//
// It never holds a private key. AC-32 and the repo's own policy put credentials
// in the OS credential store; the config only says WHERE to fetch one from. A
// key pasted into the file is refused rather than tolerated, because a config
// file is exactly the plaintext location the spec rules out.
function parseNode(raw) {
  if (!raw || raw.pubkey === undefined) {
    throw new Error("config needs a node identity: node.pubkey (64-char hex or npub1…)");
  }
  const pubkey = acceptPublicKey(raw.pubkey, "config needs a node identity", "node.pubkey", "");
  for (const banned of ["privateKey", "secretKey", "nsec", "sk"]) {
    if (raw[banned] !== undefined) {
      throw new Error(
        `node.${banned}: a private key must never live in the config file — ` +
          `use the OS keychain (privateKeyRef: "keychain") or an env reference`,
      );
    }
  }
  const privateKeyRef = raw.privateKeyRef ?? "keychain";
  if (!KEY_REF.test(privateKeyRef)) {
    throw refuseKeyRef("node", privateKeyRef);
  }
  const node = { pubkey, privateKeyRef };
  // Set only when named, so `resolveModel` can tell "this node chose one" from
  // "nobody chose, use the default" — which is exactly the distinction AC-76
  // has to report.
  const model = parseModel(raw.model, "node");
  if (model !== undefined) node.model = model;
  return node;
}

// AC-26's fuse. Configurable so the pause and its notice can actually be
// exercised in a test window (TR-002: cycle 1 could not drive 20 real turns
// inside an hour), but never disableable — a cap of zero or a zero window is a
// broken fuse, not a permissive one.
function parseTurnCap(raw) {
  const limit = raw?.limit ?? 20;
  const windowMs = raw?.windowMs ?? 60 * 60 * 1000;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`turn cap limit must be a positive integer (got ${JSON.stringify(limit)})`);
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new Error(`turn cap windowMs must be a positive integer (got ${JSON.stringify(windowMs)})`);
  }
  return { limit, windowMs };
}

// How much of what the node missed while it was down it should answer (FIX-124).
//
// The default age is a DAY because the case it is for is a laptop that was off
// overnight — the actual question that found this bug. The default count is
// small because it is the bound that does the real work: inside a day a busy
// room can hold dozens of mentions, and answering all of them at once is its own
// kind of broken.
//
// Both are floors of 1 rather than 0. A zero here would not read as "be
// careful", it would read as the old silent-drop behaviour with a config key in
// front of it, which is worse than either honest option. An owner who genuinely
// wants no backlog can set the age to a minute.
// Exported because the supervisor needs the same numbers for a config object
// that did not come through here — every test builds one by hand, and so does
// any tool that constructs a Supervisor directly. Two copies of a default drift,
// and a drifted backlog window is invisible: it just answers slightly the wrong
// set of messages.
export const BACKLOG_DEFAULTS = Object.freeze({
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxItems: 5,
});

function parseBacklog(raw) {
  const maxAgeMs = raw?.maxAgeMs ?? BACKLOG_DEFAULTS.maxAgeMs;
  const maxItems = raw?.maxItems ?? BACKLOG_DEFAULTS.maxItems;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1) {
    throw new Error(`backlog maxAgeMs must be a positive integer (got ${JSON.stringify(maxAgeMs)})`);
  }
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`backlog maxItems must be a positive integer (got ${JSON.stringify(maxItems)})`);
  }
  return { maxAgeMs, maxItems };
}

// How many PROMISED messages are answered per agent per restart (F-11,
// AC-64). A promise has no age bound — the room was explicitly told the
// message was taken — so count is the only limit, and dropping is never
// silent: the overflow line names how many were left out. Floor of 1 for the
// same reason as the backlog's: a zero would be the silent-drop behaviour
// wearing a config key.
export const COVER_DEFAULTS = Object.freeze({
  replayCapPerAgent: 10,
});

function parseCover(raw) {
  const replayCapPerAgent = raw?.replayCapPerAgent ?? COVER_DEFAULTS.replayCapPerAgent;
  if (!Number.isInteger(replayCapPerAgent) || replayCapPerAgent < 1) {
    throw new Error(
      `cover replayCapPerAgent must be a positive integer (got ${JSON.stringify(replayCapPerAgent)})`,
    );
  }
  return { replayCapPerAgent };
}

// How long a message handed straight to the harness may go unanswered before
// the node relays it itself (FIX-135, F-023, AC-7).
//
// The number is a trade between the two ways this can be wrong, and only one
// of them is silent. Too SHORT and a turn that is genuinely still running gets
// a second wake, which the room sees as a duplicate answer. Too LONG and a
// message the harness swallowed sits unanswered for that long — but it does
// arrive, and the human sees why.
//
// 600 seconds is chosen against this project's own measurements rather than a
// round number: the observed turn spread is 14s to 375s (170.7s cold, 115s
// warm, 80s post-approval in cycle 9), so ten minutes clears the slowest turn
// ever recorded here by a wide margin. It is also far above AC-5's own bounds
// (30s warm, 3 minutes for an idle-exited agent), so a recovery can never
// race the guarantee it is protecting.
//
// Floor of 1 for the same reason as the backlog's and the cover cap's: a zero
// would be "relay everything twice" wearing a config key.
export const HANDOFF_DEFAULTS = Object.freeze({
  graceSec: 600,
});

function parseHandoff(raw) {
  const graceSec = raw?.graceSec ?? HANDOFF_DEFAULTS.graceSec;
  if (!Number.isInteger(graceSec) || graceSec < 1) {
    throw new Error(`handoff graceSec must be a positive integer (got ${JSON.stringify(graceSec)})`);
  }
  return { graceSec };
}

// The run402 workshop, per room (DD-27). Opt-in and deliberately tiny: a room
// with no `workshop` block cannot deploy at all, which is the safety valve
// against an accidental spend as well as the rollback for this whole feature.
//
// The project is named HERE, by the owner, and never by an agent or by whoever
// asked it for something: a project id and a public subdomain are a resource
// commitment, and letting a cross-owner requester aim one is how a deploy path
// becomes someone else's problem.
function parseWorkshop(raw, channel) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`room "${channel}": workshop must be an object naming a run402 project`);
  }
  const allowed = new Set(["project", "subdomain"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(`room "${channel}": unknown workshop setting "${key}"`);
    }
  }
  if (typeof raw.project !== "string" || raw.project.trim() === "") {
    throw new Error(`room "${channel}": workshop.project must be a run402 project id`);
  }
  if (raw.subdomain !== undefined && (typeof raw.subdomain !== "string" || raw.subdomain.trim() === "")) {
    throw new Error(`room "${channel}": workshop.subdomain must be a non-empty string when set`);
  }
  return { project: raw.project.trim(), subdomain: raw.subdomain?.trim() ?? null };
}

// FIX-97 (AC-40, AC-42): the optional build pin — the Buzz build this room was
// verified against. Absent is legal (doctor then says, loudly, that the room
// is unpinned); present-but-malformed is refused at load, because a pin that
// silently fails to parse is exactly the silent drift it exists to catch.
function parseBuzzBuild(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("buzzBuild must be an object: { version, sha256: { <binary>: <64-char hex> } }");
  }
  if (typeof raw.version !== "string" || raw.version.trim() === "") {
    throw new Error("buzzBuild.version must be a non-empty string naming the pinned Buzz build");
  }
  const entries = Object.entries(raw.sha256 ?? {});
  if (entries.length === 0) {
    throw new Error("buzzBuild.sha256 must map at least one binary name to its expected hash");
  }
  const sha256 = {};
  for (const [name, value] of entries) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
      throw new Error(`buzzBuild.sha256["${name}"] must be a 64-char hex sha256 (got ${JSON.stringify(value)})`);
    }
    sha256[name] = value.toLowerCase();
  }
  return { version: raw.version.trim(), sha256 };
}

export function parseConfig(raw) {
  if (!raw || typeof raw.relayUrl !== "string" || raw.relayUrl === "") {
    throw new Error("config needs a relayUrl");
  }
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  if (rooms.length === 0) {
    throw new Error("config needs at least one room");
  }

  const node = parseNode(raw.node);

  const parsedRooms = rooms.map((room, i) => {
    if (!room || typeof room.channel !== "string" || room.channel === "") {
      throw new Error(`room ${i}: needs a channel id`);
    }
    const agents = Array.isArray(room.agents) ? room.agents : [];
    if (agents.length === 0) {
      throw new Error(`room "${room.channel}": needs at least one agent`);
    }
    const seen = new Set();
    const parsed = agents.map((a) => parseAgent(a, seen));

    const pubkeys = new Set();
    for (const agent of parsed) {
      const key = agent.pubkey.toLowerCase();
      if (pubkeys.has(key)) {
        throw new Error(
          `room "${room.channel}": two agents share the pubkey ${agent.pubkey} — ` +
            `identity, not name, is what the room routes on`,
        );
      }
      pubkeys.add(key);
      if (key === node.pubkey.toLowerCase()) {
        throw new Error(
          `agent "${agent.name}" uses the node identity — the node must be a distinct member, ` +
            `or its own wakes would look like the agent talking to itself`,
        );
      }
    }

    // A retired agent is out of the room (AC-70), and this is the ONE place
    // that has to know. Every consumer downstream — the launcher, the profile
    // publisher (which would otherwise re-claim the name on the next `up`,
    // making retirement decorative), the key pre-flight, the dispatcher's
    // roster — reads `room.agents`. Splitting here is what makes "no longer
    // addressable" true everywhere at once rather than in whichever call sites
    // remembered to ask. They stay visible under `retiredAgents` so `retire`
    // can tell "already retired" from "never existed".
    return {
      channel: room.channel,
      respondTo: room.respondTo ?? "anyone",
      respondToAllowlist: room.respondToAllowlist,
      workshop: parseWorkshop(room.workshop, room.channel),
      agents: parsed.filter((a) => a.retired !== true),
      retiredAgents: parsed.filter((a) => a.retired === true),
    };
  });

  return {
    relayUrl: raw.relayUrl,
    node,
    turnCap: parseTurnCap(raw.turnCap),
    backlog: parseBacklog(raw.backlog),
    cover: parseCover(raw.cover),
    handoff: parseHandoff(raw.handoff),
    buzzBuild: parseBuzzBuild(raw.buzzBuild),
    stateDir: raw.stateDir ?? null,
    tools: {
      buzzDir: raw.tools?.buzzDir ?? null,
      nodeDir: raw.tools?.nodeDir ?? null,
      adapter: raw.tools?.adapter ?? null,
      extraDirs: raw.tools?.extraDirs ?? [],
    },
    rooms: parsedRooms,
  };
}

// What in this config no longer means what it says (AC-48, DD-48, FIX-120).
//
// `rooms[].channel` used to decide which channels the node watched. It does not
// any more: membership is read from the relay, as each agent, because a list
// only the node's machine can see is a list that silently disagrees with the
// room. The field still PARSES — removing it would break every existing config
// on a version bump, and it is still the cold-start answer when the relay
// cannot be reached at all — but it no longer decides, and a config that thinks
// it does is a config whose owner will be surprised.
//
// Returned rather than printed so the schema stays free of side effects and the
// wording is testable. The commands that run a node print it.
export function configDeprecations(raw) {
  const warnings = [];
  const channels = (Array.isArray(raw?.rooms) ? raw.rooms : [])
    .map((room) => room?.channel)
    .filter((channel) => typeof channel === "string" && channel !== "");

  if (channels.length > 0) {
    warnings.push(
      `rooms[].channel no longer decides which channels this node watches — ` +
        `channel membership does, read from the relay as each agent (AC-48). ` +
        `Add or remove an agent in any Buzz client and this node follows within a minute. ` +
        `The value${channels.length > 1 ? "s" : ""} in this file (${channels.join(", ")}) ` +
        `${channels.length > 1 ? "are" : "is"} used only if the relay cannot be reached at all, ` +
        `and the field will be removed once that fallback is no longer needed.`,
    );
  }
  return warnings;
}
