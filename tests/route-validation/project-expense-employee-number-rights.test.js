import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixture =
  "tests/fixtures/source2/16cf5c1a6dcb1023c2806ee47aba3d7c";

describe("project expense employee number defaults and rights Route-validation", () => {
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
