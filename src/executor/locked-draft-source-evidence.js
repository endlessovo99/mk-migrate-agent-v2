import { sha256Digest } from "../agent-review/digest.js";
import { stableStringify } from "./persistence/normalize.js";

export function validateLockedDraftSourceEvidence(current, historical, dsl) {
  const trustedDigest = dsl?.trust?.digests?.sourceDraft;
  const evidence = historical || current;
  if (sha256Digest(evidence) !== trustedDigest) {
    return diagnostic("locked_draft.historical_source_digest_mismatch");
  }
  if (
    historical &&
    stableStringify(normalizedSourcePaths(current)) !==
      stableStringify(normalizedSourcePaths(historical))
  ) {
    const currentCore = normalizedSourcePaths(current);
    const historicalCore = normalizedSourcePaths(historical);
    const currentIssues = currentCore.issues || [];
    const historicalIssues = historicalCore.issues || [];
    delete currentCore.issues;
    delete historicalCore.issues;
    const historicalIssueSet = new Set(
      historicalIssues.map((issue) => stableStringify(issue))
    );
    if (
      stableStringify(currentCore) !== stableStringify(historicalCore) ||
      currentIssues.some((issue) => !historicalIssueSet.has(stableStringify(issue)))
    ) {
      return diagnostic("locked_draft.current_source_mismatch");
    }
  }
  return [];
}

function normalizedSourcePaths(value) {
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => {
      if (
        typeof child === "string" &&
        /path$/i.test(key) &&
        child.includes("/tests/fixtures/")
      ) {
        return [key, child.slice(child.indexOf("/tests/fixtures/") + 1)];
      }
      return [key, visit(child)];
    }));
  };
  return visit(value);
}

function diagnostic(code) {
  return [{
    level: "error",
    code,
    message: "Current Source XML does not match the approved historical Source Draft.",
    path: "/sourceDraft"
  }];
}
