// The audit log's backing file.
//
// Split out of node/runtime.mjs in fix cycle 2 because the log now has TWO
// writers (DD-16): this node, and the tool gate running inside each agent's
// runtime as a separate process. The file — not any one process's memory — is
// the record, so the supervisor and the CLI both come here for it.
//
// F-007 is the reason. Its web fetch left no trace anywhere, because the only
// audit call in the product sat inside the branch the classifier never took. A
// log that can only report what the detector caught is no use for finding what
// the detector missed.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function auditFilePath(stateDir) {
  return path.join(stateDir, "audit.jsonl");
}

export function auditFile(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const file = auditFilePath(stateDir);
  return {
    sink: { append: (line) => appendFileSync(file, `${line}\n`, "utf8") },
    source: {
      read: () =>
        existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [],
    },
  };
}
