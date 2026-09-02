// The join record — what this node knows about the community it belongs to.
//
// One file, `<stateDir>/join.json`, written by `join` and read by everything
// that comes after it. It exists for two reasons:
//
//   1. AC-45 requires the EXACT policy version accepted to be recorded. That is
//      a statement about a person's consent, so it is written down rather than
//      remembered.
//   2. A profile can be published, and an agent registered, before
//      `hive402.config.json` exists — that file is written later in setup. Until
//      it does, this record is the only place that knows which relay this node
//      belongs to and which identity it joined as.
//
// It is a convenience copy of things the relay is authoritative about, never an
// authority itself: a `displayName` here means "we published this", not "this
// is what the community shows". Its own module so that `join` and `profile` can
// both use it without importing each other.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const JOIN_RECORD_FILE = "join.json";

const recordPath = (stateDir) => path.join(stateDir, JOIN_RECORD_FILE);

export function readJoinRecord(stateDir) {
  if (!stateDir) return null;
  const file = recordPath(stateDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A record we cannot read is the same as not having one for every purpose
    // here: it is a convenience, never an authority.
    return null;
  }
}

export function writeJoinRecord({ stateDir, record }) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(recordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

// Annotate an existing record. Deliberately does NOT create one: a display name
// with no membership behind it would invent a community this node never joined.
export function rememberDisplayName({ stateDir, name }) {
  const record = readJoinRecord(stateDir);
  if (!record) return null;
  const trimmed = String(name).trim();
  writeJoinRecord({ stateDir, record: { ...record, displayName: trimmed } });
  return trimmed;
}
