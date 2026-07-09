import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const JSP_TRANSLATION_PLAYBOOK = loadPlaybook("catalogs/jsp-translation-playbook.v1.json");

function loadPlaybook(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), "utf8"));
}
