import { validateMigrationDsl } from "./schema.js";

export function checkDraft(dslDraft) {
  return normalizeCheck("draft", validateMigrationDsl(dslDraft, { mode: "draft" }));
}

export function checkExecute(migrationDsl) {
  return normalizeCheck("execute", validateMigrationDsl(migrationDsl, { mode: "execute" }));
}

function normalizeCheck(kind, validation) {
  return {
    ok: validation.ok,
    status: validation.status === "ok" ? "passed" : validation.status,
    kind,
    diagnostics: validation.diagnostics
  };
}
