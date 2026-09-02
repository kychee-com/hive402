// Which build is this? (FIX-145, F-025.)
//
// One reader, because two readers is how the answer starts disagreeing with
// itself. `bin/cli.mjs` prints it for `--version`, `--help` and `doctor`;
// `readStatus` reports it so a `status` report says which build produced it.
//
// ── Why a field at all ─────────────────────────────────────────────────────
//
// Cycle 11 ran `hive402 status` and got a report missing the `configFile` and
// `stateDir` that FIX-141 had shipped to the repo an hour earlier. The command
// on PATH was a globally-installed copy that had never been repacked, and the
// only way to see that from outside was to compare file timestamps across two
// installs. A report that names its own build answers that in one line.
//
// ── Why the field is not enough on its own ─────────────────────────────────
//
// Both manifests read `0.2.0` when that happened: the stale artifact and the
// fixed source carried the same number, because FIX-141 landed without a bump.
// A version field would have printed `0.2.0` from both installs and told the
// tester nothing — a guard that cannot discriminate. So the field is worth
// exactly as much as the discipline of bumping the manifest when shipping, and
// it is read FROM that manifest so the two can never drift apart.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PACKAGE_VERSION = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;
