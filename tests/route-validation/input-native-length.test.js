import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { runRouteCase } from "./run-route-case.js";

const fixture = "tests/fixtures/route-validation/input-native-length/input-length_SysFormTemplate.xml";
const stages = () => {
  const source = cleanSourceFile(fixture);
  return { source, dsl: draftSourceDraft(source) };
};

describe("native input length policy", () => {
  it("rejects the same sourceRef shadow in detail-column evidence", () => {
    const { source } = stages();
    const columns = source.form.detailTables[0].columns;
    const shadow = structuredClone(columns.find((column) => column.id === "item_model"));
    const original = columns.find((column) => column.id === "item_title");
    shadow.id = "item_shadow";
    shadow.sourceRef = original.sourceRef;
    columns.push(shadow);
    const dsl = draftSourceDraft(source);
    for (const column of dsl.form.fields.find((field) => field.id === "fd_items").columns) {
      if (column.sourceRef === original.sourceRef) delete column.props.maxLength;
    }
    const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true }));
    assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some((item) => item.code === "trust.form.input_length_source_conflict"));
  });
  it("rejects a fixed sourceRef identity collision even after every candidate cap is removed", () => {
    const { source } = stages();
    const original = source.form.controls.find((field) => field.id === "fd_code");
    const shadow = structuredClone(source.form.controls.find((field) => field.id === "fd_note"));
    shadow.id = "fd_shadow";
    shadow.sourceRef = original.sourceRef;
    source.form.dataFields.push(shadow);
    const dsl = draftSourceDraft(source);
    const fields = dsl.form.fields.flatMap((field) => field.type === "detailTable" ? field.columns : [field]);
    fields.filter((field) => field.sourceRef === original.sourceRef).forEach((field) => delete field.props.maxLength);
    const trusted = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true });
    const checked = checkTrust(source, trusted);
    assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some((item) => item.code === "trust.form.input_length_source_conflict"));
    assert.ok(checkDraft(dsl).diagnostics.some((item) => item.code === "source.form.input_length_conflict"));
  });

  it("retains compatible source facts while preserving the duplicate-target identity gate", () => {
    for (const duplicateCap of [true, false]) {
      const { source } = stages();
      const duplicate = structuredClone(source.form.controls.find((field) => field.id === "fd_code"));
      if (!duplicateCap) delete duplicate.sourceProps.designerValues.maxlength;
      source.form.dataFields.push(duplicate);
      const dsl = draftSourceDraft(source);
      assert.equal(dsl.form.fields.find((field) => field.id === "fd_code").props.maxLength, 18);
      const policies = dsl.review.warnings.filter((warning) => warning.details?.sourceRef === duplicate.sourceRef);
      assert.equal(policies.length, 2);
      assert.ok(policies.every((warning) => warning.details.limit === 18));
      assert.ok(!dsl.review.errors?.some((error) => error.code.startsWith("source.form.input_length_")));
      const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true }));
      assert.equal(checked.ok, false);
      assert.ok(checked.diagnostics.some((error) => error.code === "dsl.field.id_duplicate"));
      assert.ok(!checked.diagnostics.some((error) => ["trust.form.input_length_source_missing", "trust.form.input_length_source_conflict"].includes(error.code)));
    }
  });

  it("does not let a model choose between conflicting same-field source representations", () => {
    const { source } = stages();
    const duplicate = structuredClone(source.form.controls.find((field) => field.id === "fd_code"));
    duplicate.sourceProps.designerValues.maxlength = "19";
    duplicate.sourceProps.metadataAttributes.length = "19";
    source.form.dataFields.push(duplicate);
    const dsl = draftSourceDraft(source);
    for (const limit of [18, 19, undefined]) {
      const candidate = structuredClone(dsl);
      candidate.form.fields.find((field) => field.id === "fd_code").props.maxLength = limit;
      const trusted = createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true });
      trusted.review.warnings = [];
      const checked = checkTrust(source, trusted);
      assert.equal(checked.ok, false);
      assert.ok(checked.diagnostics.some((item) => item.code === "trust.form.input_length_source_conflict"));
    }
  });

  it("does not permit non-input source caps to become input constraints without a supported transition", () => {
    for (const sourceKind of ["textarea", "rtf"]) {
      const { source } = stages();
      source.form.controls.find((field) => field.id === "fd_description").sourceProps.designerType = sourceKind;
      const dsl = draftSourceDraft(source);
      assert.equal(checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true })).ok, true);
      for (const limit of [7, 600, undefined]) {
        const candidate = structuredClone(dsl);
        const field = candidate.form.fields.find((field) => field.id === "fd_description");
        field.type = "text";
        field.componentId = "xform-input";
        if (limit === undefined) delete field.props.maxLength;
        else field.props.maxLength = limit;
        const checked = checkTrust(source, createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true }));
        assert.equal(checked.ok, false);
        assert.ok(checked.diagnostics.some((item) => item.code === "trust.form.input_length_component_transition_unproven"));
      }
    }
  });
  it("rejects non-integer, non-positive and unsafe DSL maxLength values at the catalog boundary", () => {
    for (const value of [0, -1, 1.5, "18", [18], null, true, 9007199254740992]) {
      const { dsl } = stages();
      dsl.form.fields.find((field) => field.id === "fd_code").props.maxLength = value;
      const checked = checkDraft(dsl);
      assert.equal(checked.ok, false, JSON.stringify(value));
      assert.ok(checked.diagnostics.some((item) => item.code.startsWith("catalog.props.") && item.path.endsWith("/maxLength")));
    }
  });
  it("keeps rich text behavior and explicit input 200 distinct from an absent input limit", () => {
    const { source } = stages();
    const code = source.form.controls.find((field) => field.id === "fd_code");
    code.sourceProps.designerValues.maxlength = "200";
    code.sourceProps.metadataAttributes.length = "200";
    const rich = source.form.controls.find((field) => field.id === "fd_description");
    rich.sourceProps.designerType = "rtf";
    const dsl = draftSourceDraft(source);
    assert.equal(dsl.form.fields.find((field) => field.id === "fd_code").props.maxLength, 200);
    assert.equal(dsl.form.fields.find((field) => field.id === "fd_note").props.maxLength, undefined);
    const projectedRich = dsl.form.fields.find((field) => field.id === "fd_description");
    assert.equal(projectedRich.componentId, "xform-rich-text");
    assert.equal(projectedRich.props.maxLength, 600);
    assert.equal(dsl.review.warnings.filter((item) => item.code === "source.form.input_length_target_counting").length, 4);
    const prepared = prepareSample(dsl);
    const richNative = xformConfig(prepared.update).dataModel.flatMap((model) => model.fdFields || []).find((field) => field.fdName === "fd_description");
    assert.equal(richNative.fdLength, 200);
    assert.equal(JSON.parse(richNative.fdAttribute).config.controlProps.maxLength, 600);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });

  it("also rejects invalid and conflicting detail-column limits", () => {
    for (const kind of ["invalid", "conflict"]) {
      const { source } = stages();
      const column = source.form.detailTables[0].columns.find((field) => field.id === "item_model");
      if (kind === "invalid") column.sourceProps.designerValues.maxlength = false;
      else column.sourceProps.metadataAttributes.length = "37";
      const dsl = draftSourceDraft(source);
      assert.ok(checkDraft(dsl).diagnostics.some((item) => item.code === `source.form.input_length_${kind}`));
      const candidate = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true });
      candidate.review.warnings = [];
      const checked = checkTrust(source, candidate);
      assert.equal(checked.ok, false);
      assert.ok(checked.diagnostics.some((item) => item.code === `trust.form.input_length_source_${kind}`));
    }
  });
  it("records target weighted counting with independent ASCII, Chinese and emoji evidence", () => {
    const runtime = JSON.parse(readFileSync("tests/fixtures/route-validation/input-native-length/qas-length-validator.json", "utf8"));
    const prepared = prepareSample(stages().dsl);
    const config = xformConfig(prepared.update);
    const cases = [
      ["fd_code", "A".repeat(18), true], ["fd_code", "A".repeat(19), false],
      ["fd_code", "中".repeat(6), true], ["fd_code", "中".repeat(7), false],
      ["fd_code", "é".repeat(9), true], ["fd_code", "é".repeat(10), false],
      ["fd_code", "😀".repeat(3), true], ["fd_code", "😀".repeat(4), false],
      ["fd_code", "", true], ["item_unit", "A".repeat(10), true],
      ["item_unit", "A".repeat(11), false], ["item_unit", "中".repeat(3), true],
      ["item_unit", "中".repeat(4), false], ["item_unit", "😀", true],
      ["item_unit", "😀😀", false]
    ];
    for (const [id, value, accepted] of cases) {
      const field = config.dataModel.flatMap((model) => model.fdFields || []).find((field) => field.fdName === id);
      const context = vm.createContext({ s: field.fdLength, d: 0, o: { fmtMsg: (_key, fallback) => fallback } });
      const validator = new vm.Script(`(${runtime.validatorFunction})`).runInContext(context, { timeout: 1000 });
      let error;
      validator({}, value, (message) => { error = message; });
      assert.equal(error === undefined, accepted, `${id}: ${value}`);
    }
  });

  it("blocks invalid complete XML declarations while keeping original source bytes intact", () => {
    const original = readFileSync(fixture, "utf8");
    const directory = mkdtempSync(join(tmpdir(), "input-length-"));
    try {
      for (const invalid of ["0", "-1", "1.5", "not-a-limit"]) {
        const file = join(directory, "invalid_SysFormTemplate.xml");
        writeFileSync(file, original.replace('maxlength:"18"', `maxlength:"${invalid}"`));
        const dsl = draftSourceDraft(cleanSourceFile(file));
        assert.ok(checkDraft(dsl).diagnostics.some((item) => item.code === "source.form.input_length_invalid"), invalid);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(readFileSync(fixture, "utf8"), original);
  });

  it("accepts equal aliases and typed integers without deriving a cap from metadata alone", () => {
    const { source } = stages();
    const field = source.form.controls.find((field) => field.id === "fd_code");
    field.sourceProps.designerValues.maxLength = 18;
    const dsl = draftSourceDraft(source);
    assert.equal(dsl.form.fields[0].props.maxLength, 18);
    assert.equal(checkDraft(dsl).ok, true);
    delete field.sourceProps.designerValues.maxLength;
    delete field.sourceProps.designerValues.maxlength;
    const missing = draftSourceDraft(source);
    assert.equal(missing.form.fields[0].props.maxLength, undefined);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, missing, { externalAgentReviewed: true })).ok, true);
  });

  it("completes the authorized fake draft route with the target policy still explicit", async () => {
    const result = await runRouteCase("input-native-length-success");
    assert.equal(result.execution.status, "written_with_warnings");
    const policies = result.dsl.review.warnings.filter((item) => item.code === "source.form.input_length_target_counting");
    assert.equal(policies.length, 4);
    assert.ok(policies.every((item) => item.details.sourceCounting === "unverified"));
  });
  it("binds input caps and the target-counting policy to immutable source evidence", () => {
    const { source, dsl } = stages();
    const sourceRefs = [dsl.form.fields[0].sourceRef, ...dsl.form.fields.find((field) => field.id === "fd_items").columns.map((field) => field.sourceRef)];
    const fields = (value) => value.form.fields.flatMap((field) => field.type === "detailTable" ? field.columns : [field]);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true })).ok, true);
    for (const sourceRef of sourceRefs) {
      for (const mutation of ["delete", "larger", "smaller", "delete-hints", "policy-delete", "policy-forge", "component-change"]) {
        const candidate = structuredClone(dsl);
        const field = fields(candidate).find((field) => field.sourceRef === sourceRef);
        if (mutation === "delete" || mutation === "delete-hints") delete field.props.maxLength;
        if (mutation === "delete-hints") delete field.sourceProps;
        if (mutation === "larger") field.props.maxLength += 1;
        if (mutation === "smaller") field.props.maxLength -= 1;
        if (mutation === "component-change") field.componentId = "xform-textarea";
        if (mutation === "policy-delete") candidate.review.warnings = candidate.review.warnings.filter((warning) => warning.details?.sourceRef !== sourceRef);
        if (mutation === "policy-forge") candidate.review.warnings.find((warning) => warning.details?.sourceRef === sourceRef).details.sourceCounting = "equivalent";
        const checked = checkTrust(source, createTrustedMigrationDsl(source, candidate, { externalAgentReviewed: true }));
        assert.equal(checked.ok, false, mutation);
        assert.ok(checked.diagnostics.some((item) => item.code.startsWith("trust.form.input_length_")), mutation);
      }
    }
    const fabricated = structuredClone(dsl);
    fabricated.form.fields.find((field) => field.id === "fd_note").props.maxLength = 200;
    const result = checkTrust(source, createTrustedMigrationDsl(source, fabricated, { externalAgentReviewed: true }));
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === "trust.form.input_length_source_missing"));
  });

  it("fails closed on invalid or conflicting explicit limits even if draft errors are removed", () => {
    for (const value of ["0", "-1", "1.5", "1e2", "", 1.5, [18], {}, { toString: "18" }, null, false, "9007199254740992"]) {
      const { source } = stages();
      source.form.controls.find((field) => field.id === "fd_code").sourceProps.designerValues.maxlength = value;
      const dsl = draftSourceDraft(source);
      assert.equal(checkDraft(dsl).ok, false, JSON.stringify(value));
      const trusted = createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true });
      trusted.form.fields.find((field) => field.id === "fd_code").props.maxLength = 18;
      const checked = checkTrust(source, trusted);
      assert.equal(checked.ok, false, JSON.stringify(value));
      assert.ok(checked.diagnostics.some((item) => item.code === "trust.form.input_length_source_invalid"));
    }
    for (const conflict of ["metadata", "designer-alias"]) {
      const { source } = stages();
      const field = source.form.controls.find((field) => field.id === "fd_code");
      if (conflict === "metadata") field.sourceProps.metadataAttributes.length = "19";
      else field.sourceProps.designerValues.maxLength = "19";
      const dsl = draftSourceDraft(source);
      assert.ok(checkDraft(dsl).diagnostics.some((item) => item.code === "source.form.input_length_conflict"));
      const checked = checkTrust(source, createTrustedMigrationDsl(source, dsl, { externalAgentReviewed: true }));
      assert.equal(checked.ok, false);
      assert.ok(checked.diagnostics.some((item) => item.code === "trust.form.input_length_source_conflict"));
    }
  });
  it("persists both native length facts and rejects missing or contradictory readback", () => {
    const { dsl } = stages();
    const prepared = prepareSample(dsl);
    const config = xformConfig(prepared.update);
    const native = (config, id) => config.dataModel.flatMap((model) => model.fdFields || []).find((field) => field.fdName === id);
    for (const [id, limit] of [["fd_code", 18], ["item_title", 70], ["item_model", 36], ["item_unit", 10]]) {
      const field = native(config, id);
      assert.equal(field.fdLength, limit);
      assert.equal(JSON.parse(field.fdAttribute).config.controlProps.maxLength, limit);
      assert.equal(field.fdDataType, "varchar");
      for (const mutation of ["missing-length", "wrong-length", "array-length", "missing-prop", "wrong-prop", "both-wrong", "number-storage"]) {
        const changed = structuredClone(prepared.update), altered = xformConfig(changed);
        const target = native(altered, id), attribute = JSON.parse(target.fdAttribute);
        if (mutation === "missing-length") delete target.fdLength;
        if (mutation === "wrong-length") target.fdLength = limit + 1;
        if (mutation === "array-length") target.fdLength = [limit];
        if (mutation === "missing-prop") delete attribute.config.controlProps.maxLength;
        if (mutation === "wrong-prop") attribute.config.controlProps.maxLength = limit + 1;
        if (mutation === "both-wrong") { target.fdLength = limit + 1; attribute.config.controlProps.maxLength = limit + 1; }
        if (mutation === "number-storage") target.fdDataType = "number";
        target.fdAttribute = JSON.stringify(attribute);
        changed.mechanisms["sys-xform"].fdConfig = JSON.stringify(altered);
        const checked = prepared.verify(changed);
        assert.equal(checked.ok, false, `${id}: ${mutation}`);
        assert.ok(checked.diagnostics.some((item) => item.code === "readback.form.prop_maxLength_mismatch"), `${id}: ${mutation}`);
      }
    }
    assert.equal(native(config, "fd_note").fdLength, 200);
    assert.equal(native(config, "fd_description").fdLength, 600);
    assert.equal(prepared.verify(prepared.update).ok, true);
  });
  it("keeps explicit main/detail limits with an auditable target-counting policy", () => {
    const { source, dsl } = stages();
    const main = dsl.form.fields.find((field) => field.id === "fd_code");
    const columns = dsl.form.fields.find((field) => field.id === "fd_items").columns;
    assert.equal(main.props.maxLength, 18);
    assert.deepEqual(columns.map((field) => field.props.maxLength), [70, 36, 10]);
    assert.equal(dsl.form.fields.find((field) => field.id === "fd_note").props.maxLength, undefined);
    assert.equal(dsl.form.fields.find((field) => field.id === "fd_description").props.maxLength, 600);
    const policies = dsl.review.warnings.filter((warning) => warning.code === "source.form.input_length_target_counting");
    assert.equal(policies.length, 4);
    assert.ok(policies.every((warning) => warning.details.policy === "qas-native-weighted-v1" &&
      warning.details.sourceCounting === "unverified" && warning.details.htmlTruncation === false));
    assert.equal(source.form.controls.find((field) => field.id === "fd_code").sourceProps.designerValues.maxlength, "18");
    assert.equal(checkDraft(dsl).ok, true);
  });
});
