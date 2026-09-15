import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
const source = cleanSourceFile("tests/fixtures/route-validation/payment-address-title/route-payment-title_SysFormTemplate.xml");
const draft = draftSourceDraft(source);
const ids = ["fd_37ba4a798ceaee", "fd_37ba4a71aeb34a"];
describe("payment request address caption evidence", () => {
  it("hides stale internal labels while preserving visible captions and context defaults", () => {
    for (const [index, id] of ids.entries()) {
      const f = draft.form.fields.find(f => f.id === id);
      assert.equal(f.props.hiddenLabel, true);
      assert.equal(f.sourceProps.layoutCell.renderer, "xform:address");
      assert.equal(f.sourceProps.layoutCell.relation, "retained-source-caption");
      assert.deepEqual(f.props.defaultValue, { kind: "context", source: index ? "creatorDept" : "creator" });
    }
    assert.equal(draft.form.fields.find(f => f.id === "fd_37ba4934fa7dc8").props.content, "申请人");
    assert.equal(draft.form.fields.find(f => f.id === "fd_37ba4935ff980a").props.content, "申请人部门");
  });
  it("persists hidden address labels in both clients and verifies complete form", () => {
    const p = prepareSample(draft), cfg = xformConfig(p.update);
    for (const id of ids) {
      const a = JSON.parse(cfg.dataModel[0].fdFields.find(f => f.fdName === id).fdAttribute).config;
      for (const device of ["desktop", "mobile"]) {
        assert.equal(a.controlProps[device].hiddenLabel, true);
        assert.equal(a.labelProps[device].hiddenLabel, true);
      }
    }
    const r = p.verify(p.update);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  });
  it("does not hide a label using mismatched address property evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "payment-address-evidence-"));
    try {
      const xml = readFileSync("tests/fixtures/route-validation/payment-address-title/route-payment-title_SysFormTemplate.xml", "utf8");
      const changed = xml.replaceAll('propertyName="extendDataFormInfo.value(fd_37ba4a798ceaee.name)"', 'propertyName="extendDataFormInfo.value(unrelated.name)"');
      assert.notEqual(changed, xml);
      const file = join(dir, "negative_SysFormTemplate.xml");
      writeFileSync(file, changed);
      const candidate = draftSourceDraft(cleanSourceFile(file));
      assert.notEqual(candidate.form.fields.find(f => f.id === ids[0]).props.hiddenLabel, true);
      assert.equal(candidate.form.fields.find(f => f.id === ids[1]).props.hiddenLabel, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
