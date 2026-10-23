import assert from "node:assert/strict";
import { sha256Digest } from "../agent-review/digest.js";
import { withoutMechanismTokens } from "./published-form-patch.js";
import { prepareChoiceOtherLayoutConfig } from "./choice-other-layout-update-plan.js";

const same = (a, b) => sha256Digest(a ?? null) === sha256Digest(b ?? null);

/** Pure layout-only design plan; official forms and published workflow stay protected. */
export function prepareChoiceOtherDesignSync({ before, priorDsl, dsl, categoryId }) {
  const { template, officialForm, workflow } = before, xform = template.mechanisms?.["sys-xform"];
  assert.ok(template.fdName?.startsWith("MK_TEST_") && template.fdCategory?.fdId === categoryId);
  assert.ok([1, 2].includes(template.fdStatus) && xform?.fdId === template.fdId && xform.fdStatus === "official");
  assert.ok(xform.fdVersionId === officialForm.fdId && officialForm.fdXForm?.fdId === template.fdId &&
    officialForm.fdEntityId === template.fdId && officialForm.fdStatus === "official" &&
    officialForm.fdTableName === template.fdTableName && xform.fdTableName === template.fdTableName);
  const bindings = template.mechanisms.lbpmTemplate;
  assert.ok(bindings?.length === 1 && bindings[0].fdId === workflow.fdId);
  for (const w of [workflow, bindings[0]]) assert.ok(w.fdEntityId === template.fdId && w.isDraft === false && w.fdStatus === "published" && w.fdContent === workflow.fdContent && w.fdContent);
  const plan = prepareChoiceOtherLayoutConfig({ config: JSON.parse(xform.fdConfig), priorDsl, dsl });
  const expected = structuredClone(before);
  expected.template.mechanisms["sys-xform"].fdConfig = JSON.stringify(plan.config);
  const payload = structuredClone(expected.template);
  // The native existing-template basic-info update omits definition content
  // while keeping isDraft:false; do not enter its workflow designer save path.
  delete payload.mechanisms.lbpmTemplate[0].fdContent;
  return { payload, expected, changes: plan.changes, groups: plan.groups, changed: plan.changed,
    verify(after) {
      const checks = { officialUnchanged: same(withoutMechanismTokens(officialForm), withoutMechanismTokens(after.officialForm)) };
      try {
        const left = withoutMechanismTokens(expected.template), right = withoutMechanismTokens(after.template);
        const lw = withoutMechanismTokens(workflow), rw = withoutMechanismTokens(after.workflow);
        assert.equal(rw.fdId, lw.fdId);
        nativeTime(lw, rw, "fdAlterTime");
        checks.workflowUnchanged = same(lw, rw);
        assert.equal(right.mechanisms.lbpmTemplate?.length, 1);
        assert.equal(right.mechanisms.lbpmTemplate[0].fdId, left.mechanisms.lbpmTemplate[0].fdId);
        nativeTime(left.mechanisms.lbpmTemplate[0], right.mechanisms.lbpmTemplate[0], "fdAlterTime");
        const from = left.fdAlterTime, to = right.mechanisms["sys-xform"].fdAlterTime;
        nativeTime(left, right, "fdAlterTime");
        const lx = left.mechanisms["sys-xform"], rx = right.mechanisms["sys-xform"];
        nativeTime(lx, rx, "fdAlterTime");
        const a = JSON.parse(lx.fdConfig), b = JSON.parse(rx.fdConfig);
        assert.equal(a.dataModel.length, b.dataModel.length);
        for (let i = 0; i < a.dataModel.length; i++) {
          const old = a.dataModel[i], current = b.dataModel[i];
          assert.equal(current.fdId, old.fdId); assert.equal(current.fdTableName, old.fdTableName); assert.equal(current.fdType, old.fdType);
          if (!same(old.fdAlterTime, current.fdAlterTime)) {
            assert.ok(Number.isSafeInteger(current.fdAlterTime) && Number.isSafeInteger(from) && Number.isSafeInteger(to) &&
              current.fdAlterTime >= from && current.fdAlterTime <= to &&
              (!Object.hasOwn(old, "fdAlterTime") || Number.isSafeInteger(old.fdAlterTime) && current.fdAlterTime >= old.fdAlterTime));
            delete old.fdAlterTime; delete current.fdAlterTime;
          }
          if (!Object.hasOwn(old, "fdDeletedFields") && same(current.fdDeletedFields, [])) delete current.fdDeletedFields;
          if (old.fdType === "detail" && !Object.hasOwn(old, "fdAlter") && Object.hasOwn(current, "fdAlter")) {
            assert.ok(right.fdAlter?.fdId && same(current.fdAlter, right.fdAlter) && same(left.fdAlter, right.fdAlter));
            delete current.fdAlter;
          }
        }
        lx.fdConfig = a; rx.fdConfig = b;
        checks.designAndProtectedTemplate = same(left, right);
      } catch { checks.designAndProtectedTemplate = false; checks.workflowUnchanged ??= false; }
      return { ok: Object.values(checks).every(Boolean), checks };
    }
  };
}

function nativeTime(left, right, key) {
  if (same(left[key], right[key])) return;
  assert.ok(Number.isSafeInteger(left[key]) && Number.isSafeInteger(right[key]) && right[key] >= left[key]);
  delete left[key]; delete right[key];
}
