import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { localCurrencyHelperCandidates } from "../../src/translator/local-currency-helper.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";

const fixturePath = "tests/fixtures/source/18aac2e235a65c382f6fe264e1dba521";

describe("local currency helper Route case", () => {
  it("compiles the exact pure helper into a proof-bound onChange action", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions.find((candidate) => (
      candidate.id === "fd_39e5e085265aaa.script.1.event.1"
    ));

    assert.equal(action.translationStatus, "mapped");
    assert.equal(action.functionMappings[0].basis, "deterministic-local-currency-helper");
    assert.equal(action.deterministicBranchProof.basis, "deterministic-local-currency-helper");
    assert.match(action.function, /MKXFORM\.setValue\("fd_343454314c4bfc", convertCurrency\(value\)\)/);
    assert.doesNotMatch(action.function, /new\s+Array/);
    assert.doesNotThrow(() => Function("MKXFORM", `${action.function}; return onChange;`));
    assert.equal(
      checkDraft(dslDraft).diagnostics.some((diagnostic) => diagnostic.level === "error"),
      false
    );

    const changed = structuredClone(dslDraft);
    const changedAction = changed.scripts.actions.find((candidate) => candidate.id === action.id);
    changedAction.function = changedAction.function.replace("'圆'", "'元'");
    assert.equal(
      checkDraft(changed).diagnostics.some((diagnostic) => (
        diagnostic.code === "dsl.scripts.deterministic_branch_proof_invalid"
      )),
      true
    );
  });

  it("rejects a similarly shaped helper with an external side effect", () => {
    const sourceDraft = cleanSourceFile(fixturePath);
    const source = structuredClone(sourceDraft.scripts.sources.find((candidate) => (
      candidate.sourceRef === "source.form.jsp.fd_39e5e085265aaa.script.1"
    )));
    source.javascript = source.javascript.replace(
      "function convertCurrency(money) {",
      "function convertCurrency(money) { audit(money);"
    );
    const form = draftSourceDraft(sourceDraft).form;

    assert.deepEqual(localCurrencyHelperCandidates(source, form), []);
  });
});
