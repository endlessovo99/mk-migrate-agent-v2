import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentReview } from "../../src/agent-review/index.js";
import { buildDryRunPlan } from "../../src/executor/dry-run.js";
import { executeDsl } from "../../src/executor/execute.js";
import { NEWOA_SIT_BASE_URL } from "../../src/executor/newoa-client.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { FakeNewoaAdapter } from "./fake-newoa-adapter.js";

const fixture = "tests/fixtures/source2/16a52c7974b193a9d9bde384bdb9cb22";
const placeholder = "简述成立时间、注册资金、人员规模、主营业务等";

describe("Source2 placeholder static-property Route case", { concurrency: false }, () => {
  it("promotes a placeholder-only onLoad through trusted DSL and fake readback", async () => {
    const sourceDraft = cleanSourceFile(fixture);
    const dslDraft = draftSourceDraft(sourceDraft);
    const action = dslDraft.scripts.actions.find((candidate) =>
      candidate.coverage?.staticProps?.some((entry) =>
        entry.fieldId === "fd_374945ba7a34de" &&
        entry.prop === "placeholder" &&
        entry.value === placeholder
      )
    );

    assert.ok(action);
    assert.equal(action.coverage.status, "covered");
    assert.deepEqual(action.coverage.residuals, []);
    assert.equal(
      dslDraft.form.fields.find((candidate) =>
        candidate.id === "fd_374945ba7a34de"
      )?.props.placeholder,
      placeholder
    );

    const review = await runAgentReview(sourceDraft, dslDraft, {
      provider: placeholderReviewProvider(),
      reviewedAt: "2026-07-29T00:00:00.000Z",
      maxRepairAttempts: 0
    });
    assert.equal(review.ok, true, JSON.stringify(review.report?.diagnostics));

    const field = review.dsl.form.fields.find((candidate) =>
      candidate.id === "fd_374945ba7a34de"
    );
    const reviewedAction = review.dsl.scripts.actions.find((candidate) =>
      candidate.id === action.id
    );
    assert.equal(field.props.placeholder, placeholder);
    assert.equal(reviewedAction.translationStatus, "omitted");
    assert.equal(reviewedAction.function, "");
    assert.equal(review.dsl.trust.executable, true);

    const dryRun = buildDryRunPlan(review.dsl);
    assert.equal(dryRun.ok, true);

    const adapter = new Source2FakeNewoaAdapter(review.dsl.template.authorization);
    const execution = await executeDsl(review.dsl, {
      client: adapter,
      credentials: {
        username: "route-test-user",
        encryptedPassword: "route-test-encrypted-password"
      },
      confirmWrite: true,
      targetCategoryId: "route-category-id",
      baseUrl: NEWOA_SIT_BASE_URL,
      now: new Date("2026-07-29T00:00:00.000Z")
    });

    assert.equal(execution.ok, true, JSON.stringify(execution.diagnostics));
    assert.equal(execution.readback.ok, true);
    assert.equal(
      execution.readback.form.fields.find((candidate) =>
        candidate.id === "fd_374945ba7a34de"
      )?.placeholder,
      placeholder
    );
  });
});

class Source2FakeNewoaAdapter extends FakeNewoaAdapter {
  constructor(templateAuthorization) {
    super("persist", { templateAuthorization });
  }

  async getElementInfo(targets) {
    const known = targets.flatMap((fdId) => {
      const participant = source2Participants.get(fdId);
      return participant ? [structuredClone(participant)] : [];
    });
    if (known.length === targets.length) {
      this.record({ operation: "get-element-info", targets: structuredClone(targets) });
      return known;
    }
    return super.getElementInfo(targets);
  }
}

const source2Participants = new Map([
  ["149cb36bda232828b2168944bde8c95b", {
    fdId: "149cb36bda232828b2168944bde8c95b",
    fdName: "部门领导",
    fdOrgType: 32
  }],
  ["16701c8f94a1ca058b89d3b42cbb09f9", {
    fdId: "16701c8f94a1ca058b89d3b42cbb09f9",
    fdName: "电气数科_商务经理",
    fdOrgType: 4
  }],
  ["149cbca19a5f9a6db33d2a74e50af173", {
    fdId: "149cbca19a5f9a6db33d2a74e50af173",
    fdName: "分管领导",
    fdOrgType: 32
  }],
  ["1862f65358f870358984903439da7edb", {
    fdId: "1862f65358f870358984903439da7edb",
    fdName: "电气数科_总经理",
    fdOrgType: 4
  }],
  ["165fa11ff7f966ab48b6908465f99e3a", {
    fdId: "165fa11ff7f966ab48b6908465f99e3a",
    fdName: "电气数科资源计划中心_总经理",
    fdOrgType: 4
  }]
]);

function placeholderReviewProvider() {
  return {
    metadata() {
      return {
        provider: "local-codex-review",
        baseUrl: "offline://local-codex-review",
        model: "codex-worker"
      };
    },
    async review({ dslDraft, reviewScope }) {
      const patches = (dslDraft.scripts.actions || []).flatMap((action, actionIndex) => {
        if (!reviewScope?.actionIndexes?.includes(actionIndex)) return [];
        const staticProp = action.coverage?.staticProps?.find((entry) =>
          entry.prop === "placeholder"
        );
        if (!staticProp || action.coverage?.residuals?.length) return [];

        const scriptPatch = (path, value) => evidencePatch(
          `/scripts/actions/${actionIndex}/${path}`,
          value,
          action.sourceRefs
        );
        return [
          scriptPatch("function", ""),
          scriptPatch("translationStatus", "omitted"),
          scriptPatch("functionMappings", [{
            source: "GetXFormFieldById(...).setAttribute('placeholder', literal)",
            target: "form.fields[].props.placeholder",
            basis: "static-form-prop",
            reviewRequired: false
          }]),
          scriptPatch("coverage", action.coverage)
        ];
      });

      return {
        ok: true,
        status: "received",
        stage: "agent-review.provider",
        provider: "local-codex-review",
        baseUrl: "offline://local-codex-review",
        model: "codex-worker",
        promptVersion: "route-placeholder-static-coverage-v1",
        rawText: JSON.stringify({
          summary: "Local Codex Review closed exact placeholder static-property coverage.",
          patches,
          diagnostics: []
        })
      };
    }
  };
}

function evidencePatch(path, value, sourceRefs) {
  return {
    op: "replace",
    path,
    value,
    sourceRefs,
    evidence: [
      "The action-local source only assigns this literal placeholder to the same ordinary field."
    ],
    confidence: 0.99,
    rationale: "Persist the exact placeholder as a field prop and omit duplicate DOM script behavior."
  };
}
