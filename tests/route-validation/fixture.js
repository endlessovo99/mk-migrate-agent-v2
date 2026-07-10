import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { integrityError } from "./integrity.js";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/route-validation");

export function resolveRouteFixture(source, fixtureRoot = FIXTURE_ROOT) {
  const root = resolve(fixtureRoot);
  const fixturePath = resolve(root, source.relativePath);
  if (fixturePath !== root && !fixturePath.startsWith(`${root}${sep}`)) {
    throw integrityError("route.fixture.outside_root", "Route fixture resolved outside the tracked fixture root.");
  }
  if (!existsSync(fixturePath)) {
    throw integrityError("route.fixture.missing", `Route fixture is missing: ${source.relativePath}`);
  }

  const stat = statSync(fixturePath);
  if (source.kind === "form-only") {
    if (!stat.isFile() || !/_SysFormTemplate\.xml$/i.test(fixturePath)) {
      throw integrityError("route.fixture.shape", "Form-only Route fixtures must be SysFormTemplate XML files.");
    }
    return fixturePath;
  }

  const entries = stat.isDirectory() ? readdirSync(fixturePath) : [];
  const formCount = entries.filter((entry) => /_SysFormTemplate\.xml$/i.test(entry)).length;
  const workflowCount = entries.filter((entry) => /_LbpmProcessDefinition\.xml$/i.test(entry)).length;
  if (!stat.isDirectory() || formCount !== 1 || workflowCount !== 1) {
    throw integrityError("route.fixture.shape", "Paired Route fixtures require exactly one form and one workflow XML file.");
  }
  return fixturePath;
}
