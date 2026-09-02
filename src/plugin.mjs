import { pathToFileURL } from "node:url";
import path from "node:path";

// Optional step-2 core ("the brains"). hive402 is fully functional without it:
// absent core = address-only rooms. When present, the core supplies relevance
// classification and etiquette policies through this seam.
export async function loadCore({ modulePath } = {}) {
  if (!modulePath) return null;
  const spec = path.isAbsolute(modulePath)
    ? pathToFileURL(modulePath).href
    : modulePath;
  let mod;
  try {
    mod = await import(spec);
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
  if (typeof mod.createCore !== "function") return null;
  return mod.createCore();
}
