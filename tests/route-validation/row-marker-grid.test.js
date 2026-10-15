import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkDraft } from "../../src/dsl/checks.js";
import { inspectDeterministicScriptBranchProof } from "../../src/dsl/deterministic-script-translations.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { projectNativeLayoutRows } from "../../src/executor/persistence/layout-projection.js";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { inlineRadioRowEffectCandidates } from "../../src/translator/inline-radio-row-effects.js";
import { persistAndVerify } from "../helpers/persistence.js";
import { runRouteCase } from "./run-route-case.js";

const root = "tests/fixtures/route-validation/row-marker-grid";
const nestedFixture = join(root, "mixed-nested_SysFormTemplate.xml");
const aliasFixture = join(root, "alias-lifecycle_SysFormTemplate.xml");

describe("mixed source cell and canonical row marker Route-validation", () => {
  it("keeps an ordinary control and nested table in one nonoverlapping parent slot", () => {
    const source = cleanSourceFile(nestedFixture);
    const dsl = draftSourceDraft(source);
    assertValid(dsl);
    assert.deepEqual(dsl.form.fields.map((field) => field.id).sort(), ["fd_inner", "fd_outer"]);
    assert.equal(source.form.layout.rows[0].cells.length, 1);
    assert.deepEqual(source.form.layout.rows[0].cells[0].references.map((ref) => ref.referenceType), ["layout", "layout"]);
    assert.equal(dsl.form.layout.mkTree[0].children.length, 1);
    const projected = projectNativeLayoutRows(dsl.form.layout.mkTree);
    assert.equal(projected.length, 1);
    assert.deepEqual(projected[0].cells.flatMap((cell) => cell.refIds), ["fd_outer", "fd_inner"]);
    assert.ok(projected[0].cells[0].row < projected[0].cells[1].row);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, dsl, {
      externalAgentReviewed: true
    })).ok, true);
    assert.equal(persistAndVerify(dsl).readback.ok, true);
  });

  it("preserves content before and after a nested table without moving its sibling cell", () => {
    const xml = readFileSync(nestedFixture, "utf8")
      .replace("&lt;/tbody&gt;&lt;/table&gt;&lt;/td&gt;", '&lt;/tbody&gt;&lt;/table&gt;&lt;div fd_type="inputText" fd_values=\'{id:"fd_after",label:"After",width:"80",dataType:"String"}\'&gt;&lt;input id="fd_after"/&gt;&lt;/div&gt;&lt;/td&gt;&lt;td row="0" column="2"&gt;&lt;div fd_type="inputText" fd_values=\'{id:"fd_sibling",label:"Sibling",dataType:"String"}\'&gt;&lt;input id="fd_sibling"/&gt;&lt;/div&gt;&lt;/td&gt;')
      .replace("&lt;/metadata&gt;", '&lt;extendSimpleProperty name="fd_after" type="String"/&gt;&lt;extendSimpleProperty name="fd_sibling" type="String"/&gt;&lt;/metadata&gt;');
    withSourceXml(xml, (source) => {
      const dsl = draftSourceDraft(source);
      assertValid(dsl);
      const cells = projectNativeLayoutRows(dsl.form.layout.mkTree)[0].cells;
      const find = (id) => cells.find((cell) => cell.refIds.includes(id));
      assert.ok(find("fd_outer").row < find("fd_inner").row);
      assert.ok(find("fd_inner").row < find("fd_after").row);
      assert.equal(find("fd_outer").column, find("fd_after").column);
      assert.ok(find("fd_sibling").column >= find("fd_outer").column + find("fd_outer").colspan);
      const afterCell = source.form.layout.rows.flatMap((row) => row.cells)
        .find((cell) => cell.references.some((ref) => ref.referenceId === "fd_after"));
      assert.deepEqual(afterCell.contentFlow.items[0].width, { value: 80, unit: "px" });
      assert.equal(persistAndVerify(dsl).readback.ok, true);
    });
  });

  it("leaves a nested-only source cell without artificial content rows", () => {
    const xml = readFileSync(nestedFixture, "utf8")
      .replace(/&lt;div fd_type="inputText" fd_values='\{id:"fd_outer"[^]*?&lt;\/div&gt;/, '&lt;input type="hidden" id="fd_only_row" name="fd_only_row"/&gt;');
    withSourceXml(xml, (source) => {
      const dsl = draftSourceDraft(source);
      assertValid(dsl);
      assert.equal(source.form.layout.rows.some((row) => /\.cell-\d+\.(before|after)$/.test(row.id)), false);
      assert.deepEqual(source.form.layout.rows[0].sourceMarkers, ["fd_only_row"]);
      assert.deepEqual(source.form.layout.rows[0].cells[0].references.map((ref) => ref.referenceId), ["row-0.nested-0.row-0"]);
    });
  });

  it("runs both legacy field-object change branches on the canonical persisted marker", () => {
    const source = cleanSourceFile(aliasFixture);
    const dsl = draftSourceDraft(source);
    assertValid(dsl);
    assert.equal(dsl.scripts.actions.length, 2);
    const values = {};
    const rows = {};
    const api = {
      getValue(id) { return values[id]; },
      setValue(id, value) { values[id] = value; },
      setFieldAttr(id, attribute) {
        rows[id] ||= {};
        if (attribute === 3 || attribute === 6) rows[id].required = attribute === 3;
        if (attribute === 4 || attribute === 5) rows[id].visible = attribute === 5;
      }
    };
    for (const action of dsl.scripts.actions) {
      assert.equal(action.translationStatus, "mapped");
      assert.equal(inspectDeterministicScriptBranchProof(action).ok, true);
      assert.doesNotMatch(action.function, /setFieldAttr\("fd_alias_row"/);
      const run = new Function("MKXFORM", `${action.function}; return ${action.name};`)(api);
      for (const value of ["A", "B", "", "A"]) {
        run(value);
        assert.deepEqual(rows.fd_primary_row, { visible: value === "A", required: value === "A" });
        assert.equal(values.fd_state, value === "A" ? "one" : "many");
        assert.equal(rows.fd_alias_row, undefined);
      }
      assert.equal(inspectDeterministicScriptBranchProof({ ...action, function: action.function.replaceAll("fd_primary_row", "fd_alias_row") }).ok, false);
    }
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, dsl, {
      externalAgentReviewed: true
    })).ok, true);
    assert.equal(persistAndVerify(dsl).readback.ok, true);
  });

  it("keeps a sole row marker and rejects an unhandled source side effect", () => {
    const xml = readFileSync(aliasFixture, "utf8").replace('&lt;input type="hidden" id="fd_primary_row" name="fd_primary_row"/&gt;', "");
    withSourceXml(xml, (source) => {
      const dsl = draftSourceDraft(source);
      assertValid(dsl);
      for (const action of dsl.scripts.actions) assert.match(action.function, /setFieldAttr\("fd_alias_row"/);
      const original = source.scripts.sources[0];
      assert.deepEqual(inlineRadioRowEffectCandidates({
        ...original,
        javascript: original.javascript.replace('state.value="one";', 'state.value="one"; unknownSideEffect();')
      }, dsl.form, dsl.formRules), []);
    });
  });

  it("initializes and restores canonical marker visibility across nested onLoad branches", () => {
    const dsl = draftSourceDraft(cleanSourceFile(join(root, "alias-nested-load_SysFormTemplate.xml")));
    assertValid(dsl);
    assert.equal(dsl.scripts.actions.length, 1);
    const action = dsl.scripts.actions[0];
    assert.equal(action.event, "onLoad");
    assert.equal(inspectDeterministicScriptBranchProof(action).ok, true);
    const rows = {};
    const values = {};
    const api = {
      getValue(id) { return values[id]; },
      setFieldAttr(id, attribute) {
        rows[id] ||= {};
        if (attribute === 3 || attribute === 6) rows[id].required = attribute === 3;
        if (attribute === 4 || attribute === 5) rows[id].visible = attribute === 5;
      }
    };
    const run = new Function("MKXFORM", `${action.function}; return ${action.name};`)(api);
    for (const [main, nested, visible] of [[undefined, undefined, false], ["C", "A", true], ["C", "B", false], ["A", "A", false], [["C"], ["A"], true], ["", "", false]]) {
      values.fd_type = main;
      values.fd_other = nested;
      run();
      assert.deepEqual(rows.fd_primary_row, { visible, required: false });
      assert.equal(rows.fd_alias_row, undefined);
    }
  });

  it("retains reset effects when an alias selects the persisted row", () => {
    const xml = readFileSync(aliasFixture, "utf8")
      .replaceAll('"fd_alias_row",true,true,false', '"fd_alias_row",true,true,true');
    withSourceXml(xml, (source) => {
      const dsl = draftSourceDraft(source);
      assertValid(dsl);
      const values = { fd_value: "previous" };
      const targets = new Set();
      const api = {
        getValue(id) { return values[id]; },
        setValue(id, value) { values[id] = value; },
        setFieldAttr(id) { targets.add(id); }
      };
      const action = dsl.scripts.actions[0];
      assert.equal(inspectDeterministicScriptBranchProof(action).ok, true);
      new Function("MKXFORM", `${action.function}; return ${action.name};`)(api)("A");
      assert.equal(values.fd_value, "");
      assert.equal(values.fd_state, "one");
      assert.deepEqual([...targets], ["fd_primary_row"]);
    });
  });

  it("passes review, trust, dry-run and readback with fake clients for each route", async () => {
    for (const name of ["mixed-nested", "alias-lifecycle", "alias-nested-load"]) {
      const result = await runRouteCase(`row-marker-grid-${name}-success`);
      assert.equal(result.dsl.trust.executable, true);
      assert.equal(result.dryRun.ok, true);
      assert.equal(result.execution.ok, true);
      assert.equal(result.execution.readback.ok, true);
    }
  });
});

function assertValid(dsl) {
  assert.deepEqual(checkDraft(dsl).diagnostics.filter((diagnostic) => diagnostic.level === "error"), []);
}

function withSourceXml(xml, callback) {
  const directory = mkdtempSync(join(tmpdir(), "row-marker-grid-"));
  try {
    const path = join(directory, "route_SysFormTemplate.xml");
    writeFileSync(path, xml);
    return callback(cleanSourceFile(path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
