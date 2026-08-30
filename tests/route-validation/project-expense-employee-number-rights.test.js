import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { formAttr, prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/source2/16cf5c1a6dcb1023c2806ee47aba3d7c";

describe("project expense employee number defaults and rights Route-validation", () => {
  it("keeps the source readonly payee bank fields readonly when drafting", () => {
    const draft = draftSourceDraft(cleanSourceFile(fixture));
    const config = xformConfig(prepareSample(draft).update);
    const main = config.dataModel.find((model) => model.fdType === "main");
    for (const id of ["fd_37b0420c4b3958", "fd_37b041ddf45024"]) {
      assert.equal(draft.form.fields.find((field) => field.id === id).props.readOnly, true);
      assert.equal(config.auth[0].add[main.fdTableName].fields[id].editable, false);
      const field = main.fdFields.find((field) => field.fdName === id);
      assert.equal(JSON.parse(field.fdAttribute).config.controlProps.showStatus, "readOnly");
    }
  });

  it("projects the internal/external payee load state as a native preview rule", () => {
    const draft = draftSourceDraft(cleanSourceFile(fixture));
    const rule = draft.formRules.linkage.find((rule) =>
      rule.source === "fd_37bfffeb510716" && rule.trigger === "load"
    );
    assert.ok(rule);
    assert.deepEqual(rule.when, [{ field: "fd_37bfffeb510716", op: "contains", value: "5" }]);
    assert.equal(rule.meta.partialNativeRowEffects, true);
    const value = (effects, type, target) => effects.find((effect) =>
      effect.type === type && effect.target === target
    )?.value;
    for (const target of ["qtskr_row", "qtkhh_row"]) {
      assert.equal(value(rule.effects, "visible", target), true);
      assert.equal(value(rule.effects, "required", target), true);
      assert.equal(value(rule.else, "visible", target), false);
      assert.equal(value(rule.else, "required", target), false);
    }
    for (const target of ["skr_row", "khh_row"]) {
      assert.equal(value(rule.effects, "visible", target), false);
      assert.equal(value(rule.else, "visible", target), undefined);
    }

    const native = formAttr(prepareSample(draft).update).formRule;
    const generated = [...native.display, ...native.require].filter((item) =>
      item.meta?.sourceRuleId === rule.id
    );
    assert.equal(generated.length, 4);
    assert.ok(generated.every((item) => item.choices.items[0].fieldName === "fd_37bfffeb510716"));
    assert.ok(generated.some((item) =>
      item.meta.branch === "else" &&
      item.result.some((result) =>
        result.fieldName === "fd_37c09f0b8334d2" && result.displayFlag === "hide"
      )
    ));
  });

  it("inherits current creator employee numbers and keeps them editable at draft and research approval", () => {
    const source = cleanSourceFile(fixture);
    const draft = draftSourceDraft(source);
    const fields = new Map(draft.form.fields.map((field) => [field.id, field]));

    const hydrationActions = draft.scripts.actions.filter((action) =>
      action.semanticHints?.personPropertyHydration
    );
    assert.ok(hydrationActions.some((action) =>
      action.scope === "control" &&
      action.event === "onChange" &&
      action.controlId === "fd_select_person1" &&
      action.semanticHints.personPropertyHydration.targetFieldId === "fd_person_no1" &&
      action.semanticHints.personPropertyHydration.property === "fdLoginName"
    ));
    assert.ok(hydrationActions.some((action) =>
      action.scope === "global" &&
      action.event === "onLoad" &&
      action.semanticHints.personPropertyHydration.targetFieldId === "fd_person_no1" &&
      action.function.includes("sysorg.getPersonByPersonId")
    ));
    assert.ok(hydrationActions.some((action) =>
      action.scope === "control" &&
      action.event === "onChange" &&
      action.controlId === "fd_37b041ca9cd0c2" &&
      action.semanticHints.personPropertyHydration.targetFieldId === "fd_39645f8a34ed88" &&
      action.semanticHints.personPropertyHydration.property === "fdNo"
    ));
    assert.ok(hydrationActions.some((action) =>
      action.scope === "global" &&
      action.event === "onLoad" &&
      action.semanticHints.personPropertyHydration.targetFieldId === "fd_39645f8a34ed88" &&
      action.semanticHints.personPropertyHydration.property === "fdNo"
    ));

    const payeeHydration = hydrationActions.find((action) =>
      action.scope === "global" &&
      action.event === "onLoad" &&
      action.semanticHints.personPropertyHydration.targetFieldId === "fd_39645f8a34ed88"
    );
    const writes = [];
    const onLoad = new Function(
      "MKXFORM",
      `${payeeHydration.function}; return onLoad;`
    )({
      getValue(fieldId) {
        return fieldId === "fd_select_person1"
          ? { fdId: "person-1", fdName: "孙启蒙" }
          : undefined;
      },
      callOrg(_request, callback) {
        callback(null, { fdNo: "683T7225" });
      },
      setValue(id, value) {
        writes.push([id, value]);
      }
    });
    onLoad();
    assert.deepEqual(writes, [["fd_39645f8a34ed88", "683T7225"]]);
    assert.doesNotMatch(payeeHydration.function, /setTimeout/);
    assert.match(payeeHydration.function, /fd_select_person1/);

    for (const fieldId of ["fd_person_no1", "fd_39645f8a34ed88"]) {
      assert.deepEqual(fields.get(fieldId)?.props?.defaultValue, {
        kind: "context",
        source: "creator",
        property: "fdNo"
      });
    }

    const draftNode = draft.workflow.nodes.find((node) => node.id === "N2");
    const governedResearchNode = draft.workflow.nodes.find((node) => node.id === "N136");
    const implicitResearchNodes = draft.workflow.nodes.filter((node) =>
      ["N132", "N134"].includes(node.id)
    );
    assert.equal(draftNode?.name, "起草节点");
    assert.equal(draftNode?.dataAuthority, undefined);
    assert.equal(governedResearchNode?.name, "科研审批");
    for (const fieldId of ["fd_person_no1", "fd_39645f8a34ed88"]) {
      assert.deepEqual(governedResearchNode?.dataAuthority?.fields?.[fieldId], {
        visible: true,
        editable: true,
        required: false,
        sourceMode: "edit",
        sourceRef: fields.get(fieldId)?.sourceRef
      });
    }
    assert.equal(implicitResearchNodes.length, 2);
    assert.ok(implicitResearchNodes.every((node) => node.name === "科研审批"));
    assert.ok(implicitResearchNodes.every((node) => node.dataAuthority === undefined));

    const trusted = createTrustedMigrationDsl(source, draft, {
      externalAgentReviewed: true,
      reviewerName: "route-test",
      checkedAt: "2026-08-23T00:00:00.000Z"
    });
    const prepared = prepareSample(trusted);
    const observed = observeNativeTemplate(prepared.update);

    const config = xformConfig(prepared.update);
    const formAttr = JSON.parse(config.attribute.formAttr);
    const globalOnLoad = formAttr.controlAction.global.onLoad[0].function;
    assert.match(globalOnLoad, /sysorg\.getPersonByPersonId/);

    for (const fieldId of ["fd_person_no1", "fd_39645f8a34ed88"]) {
      assert.deepEqual(
        observed.form.value.fields.find((field) => field.id === fieldId)?.props?.defaultValue,
        { kind: "context", source: "creator", property: "fdNo" }
      );
      assert.deepEqual(
        observed.workflow.value.nodes.find((node) => node.id === "N136")
          ?.dataAuthority?.fields?.[fieldId],
        { visible: true, editable: true, required: false }
      );
    }
  });
});
