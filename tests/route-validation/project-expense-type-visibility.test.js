import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { observeNativeTemplate } from "../../src/executor/persistence/observer.js";
import { prepareSample, projectTemplate, xformConfig } from "../helpers/persistence.js";

const fixture = "tests/fixtures/source2/16fa198c6a0f6d0eb6476a34812bdf74";

describe("project expense type detail visibility route", () => {
  it("keeps complementary load visibility and edit-only required behavior executable", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const expenseTypeRules = dsl.formRules.linkage.filter((rule) => rule.source === "bxlx");
    const excludedExpenseTypeRules = (dsl.formRules.review.excludedRules || [])
      .filter((rule) => rule.source === "bxlx");

    assert.equal(excludedExpenseTypeRules.length, 0);
    assert.equal(expenseTypeRules.length, 10);
    const detailOnChangeActions = dsl.scripts.actions.filter((action) =>
      action.id.startsWith("fd_37b0de6f06003a.script.1.event.")
    );
    assert.equal(
      detailOnChangeActions.every((action) =>
        action.translationStatus === "mapped" &&
        action.deterministicBranchProof?.basis === "deterministic-inline-radio-row-effects"
      ),
      true,
      "detail-row onChange actions must remain deterministically translatable"
    );
    for (const detailTableId of [
      "fd_37b0d83b385242",
      "fd_37b043b6560188",
      "fd_37b0d9407abeee",
      "fd_37b0d944369540",
      "fd_37b058dbdb8e54",
      "fd_37b05a1bb4751e"
    ]) {
      assert.equal(
        detailOnChangeActions.some((action) =>
          action.function.includes(`setFieldAttr(\"${detailTableId}\"`)
        ),
        false,
        `${detailTableId} must remain controlled through its layout sourceMarker`
      );
    }

    const entertainmentVisibility = expenseTypeRules.find((rule) =>
      rule.id === "linkage.bxlx.contains.ywzd.load"
    );
    assert.deepEqual(entertainmentVisibility.effects, [
      { type: "visible", target: "ywzd_row", value: true }
    ]);
    assert.deepEqual(entertainmentVisibility.else, [
      { type: "visible", target: "ywzd_row", value: false }
    ]);

    const entertainmentRequired = expenseTypeRules.find((rule) =>
      rule.id === "linkage.bxlx.contains.ywzd"
    );
    assert.deepEqual(entertainmentRequired.effects, [
      { type: "required", target: "ywzd_row", value: true }
    ]);
    assert.deepEqual(entertainmentRequired.else, [
      { type: "required", target: "ywzd_row", value: false }
    ]);
    assert.deepEqual(entertainmentRequired.meta.runWhen, {
      viewStatusIn: ["add", "edit"]
    });

    for (const value of ["clbx", "qtfy", "jbchef", "jbcf", "ywzd"]) {
      assert.equal(
        expenseTypeRules.some((rule) =>
          rule.trigger === "load" &&
          rule.when.some((condition) => condition.value === value) &&
          rule.effects.some((effect) => effect.type === "visible")
        ),
        true
      );
    }

    const nativeRules = observeNativeTemplate(projectTemplate(dsl)).rules.value.rules;
    const entertainmentDisplay = nativeRules.filter((rule) =>
      rule.nativeIdentity?.sourceRuleId === "linkage.bxlx.contains.ywzd.load"
    );
    const entertainmentRequiredRules = nativeRules.filter((rule) =>
      rule.nativeIdentity?.sourceRuleId === "linkage.bxlx.contains.ywzd"
    );

    assert.deepEqual(entertainmentDisplay.map((rule) => rule.kind), ["display", "display"]);
    assert.equal(entertainmentDisplay[0].conditions[0].field, "bxlx");
    assert.equal(entertainmentDisplay[0].conditions[0].value, "ywzd");
    assert.equal(
      entertainmentDisplay[0].effects.some((effect) =>
        effect.target === "fd_37b043b6560188" && effect.visible === true
      ),
      true
    );
    assert.equal(
      entertainmentDisplay[1].effects.some((effect) =>
        effect.target === "fd_37b043b6560188" && effect.visible === false
      ),
      true
    );
    assert.deepEqual(entertainmentDisplay[1].conditions, [
      { field: "bxlx", op: "notContains", value: "ywzd" },
      { field: "bxlx", op: "empty", value: "" }
    ]);
    assert.equal(entertainmentDisplay[1].logic, "or");
    for (const value of ["clbx", "qtfy", "jbchef", "jbcf", "ywzd"]) {
      const hiddenBranch = nativeRules.find((rule) =>
        rule.kind === "display" &&
        rule.nativeIdentity?.sourceRuleId === `linkage.bxlx.contains.${value}.load` &&
        rule.nativeIdentity?.branch === "else"
      );
      assert.equal(hiddenBranch?.logic, "or");
      assert.equal(
        hiddenBranch?.conditions.some((condition) =>
          condition.field === "bxlx" && condition.op === "empty" && condition.value === ""
        ),
        true,
        `${value} must hide its MK targets while reimbursement type is blank`
      );
    }
    assert.deepEqual(entertainmentRequiredRules.map((rule) => rule.kind), ["require", "require"]);
    assert.equal(
      entertainmentRequiredRules.every((rule) =>
        rule.conditions[0].field === "$formula" &&
        rule.conditions[0].value.includes("MKXFORM.viewStatus")
      ),
      true
    );
  });

  it("restores internal recipient rows when recipient identity is internal employee", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const recipientRule = dsl.formRules.linkage.find((rule) =>
      rule.id === "linkage.fd_37bfffeb510716.contains.5.load"
    );

    assert.equal(recipientRule?.translationStatus, "executable");
    assert.equal(
      recipientRule?.effects.some((effect) =>
        effect.type === "visible" && effect.target === "skr_row" && effect.value === false
      ),
      true
    );
    assert.equal(
      recipientRule?.effects.some((effect) =>
        effect.type === "visible" && effect.target === "khh_row" && effect.value === false
      ),
      true
    );
    assert.equal(
      recipientRule?.else.some((effect) =>
        effect.type === "visible" && effect.target === "skr_row" && effect.value === true
      ),
      true,
      "internal employee must restore the internal recipient row"
    );
    assert.equal(
      recipientRule?.else.some((effect) =>
        effect.type === "visible" && effect.target === "khh_row" && effect.value === true
      ),
      true,
      "internal employee must restore the internal bank row"
    );

    const nativeRules = observeNativeTemplate(projectTemplate(dsl)).rules.value.rules;
    const internalDisplay = nativeRules.find((rule) =>
      rule.kind === "display" &&
      rule.nativeIdentity?.sourceRuleId === recipientRule.id &&
      rule.nativeIdentity?.branch === "else"
    );
    for (const target of [
      "fd_37b041ca9cd0c2",
      "fd_37b041ddf45024",
      "fd_37b041589b598e",
      "fd_39636b39a00882"
    ]) {
      assert.equal(
        internalDisplay?.effects.some((effect) =>
          effect.target === target && effect.visible === true
        ),
        true,
        `${target} must be shown for internal employee`
      );
    }
  });

  it("keeps the EKP default internal-recipient field styles after switching back to internal", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const internalFieldIds = [
      "fd_37b041ca9cd0c2",
      "fd_37b041ddf45024",
      "fd_37b041589b598e",
      "fd_37b0420c4b3958",
      "fd_39636b39a00882"
    ];
    const expected = Object.fromEntries(internalFieldIds.map((fieldId) => [
      fieldId,
      {
        visible: true,
        required: fields.get(fieldId)?.props?.required === true
      }
    ]));

    const config = xformConfig(prepareSample(dsl).update);
    const formActions = JSON.parse(config.attribute.formAttr).controlAction.control;
    const action = formActions[`${config.dataModel[0].fdTableName}.fd_37bfffeb510716`]
      ?.onChange?.[0];
    assert.ok(action, "recipient identity onChange must be persisted");

    const actual = structuredClone(expected);
    const onChange = new Function(
      "MKXFORM",
      `${action.function}; return ${action.name};`
    )({
      viewStatus: "edit",
      getValue() {
        return "5";
      },
      setValue() {},
      setFieldAttr(fieldId, attribute) {
        if (!actual[fieldId]) return;
        if (attribute === 3) actual[fieldId].required = true;
        if (attribute === 4) actual[fieldId].visible = false;
        if (attribute === 5) actual[fieldId].visible = true;
        if (attribute === 6) actual[fieldId].required = false;
      }
    });
    onChange("1");

    assert.deepEqual(actual, expected);
  });

  it("keeps one editable line under the shared bank caption while retaining the robot output as data", () => {
    const dsl = draftSourceDraft(cleanSourceFile(fixture));
    const fields = new Map(dsl.form.fields.map((field) => [field.id, field]));
    const bankRow = dsl.form.layout.mkTree.find((row) => row.id === "layout.row-9");

    assert.equal(bankRow?.componentId, "xform-flex-1-4-layout");
    assert.deepEqual(bankRow?.children.map((child) => ({
      refType: child.refType,
      refIds: child.refIds,
      column: child.column,
      colspan: child.colspan
    })), [
      {
        refType: "field",
        refIds: ["fd_37b041589b598e"],
        column: 0,
        colspan: 1
      },
      {
        refType: "field",
        refIds: ["fd_39636b39a00882"],
        column: 1,
        colspan: 3
      }
    ]);

    assert.equal(fields.get("fd_37b041ddf45024")?.props.readOnly, true);
    assert.equal(fields.get("fd_37b0420c4b3958")?.props.readOnly, true);
    assert.equal(fields.get("fd_37b0420c4b3958")?.dataOnly, true);
    assert.notEqual(fields.get("fd_39636b39a00882")?.props.readOnly, true);
    assert.equal(
      fields.get("fd_37b0420c4b3958")?.props.hiddenLabel,
      true,
      "the readonly bank-name output remains under the shared EKP caption"
    );
    assert.equal(
      fields.get("fd_39636b39a00882")?.props.hiddenLabel,
      true,
      "the editable employee-number input remains under the shared EKP caption"
    );

    const robot = dsl.workflow.nodes.find((node) => node.id === "N123");
    const robotConfig = JSON.parse(robot.definition.attributes.content);
    assert.equal(robotConfig.inputParams[0].idField, "$fd_39636b39a00882$");
    assert.deepEqual(
      robotConfig.outParams.filter((param) => param.isUse === "true").map((param) => ({
        name: param.name,
        idField: param.idField
      })),
      [
        { name: "fd_bank_cardnum", idField: "fd_37b041ddf45024" },
        { name: "fd_bank", idField: "fd_37b0420c4b3958" }
      ]
    );

    const nativeFields = new Map(
      observeNativeTemplate(projectTemplate(dsl)).form.value.fields.map((field) => [field.id, field])
    );
    assert.equal(nativeFields.get("fd_37b041ddf45024")?.props.readOnly, true);
    assert.equal(nativeFields.get("fd_37b0420c4b3958")?.props.readOnly, true);
    assert.equal(nativeFields.get("fd_37b0420c4b3958")?.dataOnly, true);
    assert.notEqual(nativeFields.get("fd_39636b39a00882")?.props.readOnly, true);
    assert.equal(nativeFields.get("fd_37b0420c4b3958")?.props.hiddenLabel, true);
    assert.equal(nativeFields.get("fd_39636b39a00882")?.props.hiddenLabel, true);
  });
});
