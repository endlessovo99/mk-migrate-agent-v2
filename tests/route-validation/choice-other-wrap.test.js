import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { checkDraft } from "../../src/dsl/checks.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeChoiceLayoutHtml } from "../helpers/native-choice-layout.js";

const fixture = "tests/fixtures/route-validation/choice-other-wrap/choice-other-wrap_SysFormTemplate.xml";
const sealFixture = "tests/fixtures/source3/166d859bc79f49f5acf97474d9fa5d85/166d86064d2c8b3955ffad64e8eba196_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
const xmlWithoutDefault = xml.replace(',defaultValue:"  seed_under_score🙂  "', '')
  .replace(' defaultValue="  seed_under_score🙂  "', '');
const retainedLegacy = () => JSON.parse(readFileSync("tests/fixtures/route-validation/choice-other-wrap/retained-legacy-draft.json", "utf8"));
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...Object.values(node).flatMap(value =>
  Array.isArray(value) ? value.flatMap(nodes) : nodes(value))];
const companions = prepared => prepared.verify(prepared.update).form.layoutRows.flatMap(row => row.cells.flatMap(cell => cell.contentFlow?.companions || []));
function editView(payload, scene, edit) {
  const config = xformConfig(payload), view = JSON.parse(config.viewModel[0].fdConfig);
  edit(view.view.render[scene]);
  config.viewModel[0].fdConfig = JSON.stringify(view);
  payload.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}
function stages(text = xml, options) {
  const dir = mkdtempSync(join(tmpdir(), "choice-other-wrap-"));
  try {
    const path = join(dir, "wrap_SysFormTemplate.xml");
    writeFileSync(path, text);
    const source = cleanSourceFile(path);
    return { source, draft: draftSourceDraft(source, options) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("blocks a source Other default until its empty-selection persistence is verified", () => {
  const { source, draft } = stages(), choice = draft.form.fields.find(f => f.id === "fd_kind"), note = draft.form.fields.find(f => f.id === "fd_note");
  assert.equal(choice.sourceProps.otherTextCompanion?.id, note.id);
  assert.equal(choice.props.options.at(-1).value, "other_");
  assert.equal(choice.props.options.at(-1).type, "other");
  assert.equal(note.dataOnly, true);
  assert.equal(choice.props.defaultValue.value, "other_  seed_under_score🙂  ");
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "dsl.form.native_other_default_unverified"));
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, false);
  assert.throws(() => prepareSample(draft), { code: "projection.choice_other.checkbox_storage_unproven" });
});

for (const sizing of ["adaptive", "source"]) for (const kind of ["Checkbox", "Radio"]) {
  it(`projects native ${kind} Other through ${sizing} layout`, () => {
    const { source, draft } = stages(xmlWithoutDefault.replaceAll("inputCheckbox", `input${kind}`).replaceAll("xform:checkbox", `xform:${kind.toLowerCase()}`), { layoutSizing: sizing });
    const choice = draft.form.fields.find(f => f.id === "fd_kind"), p = prepareSample(draft);
    assert.equal(choice.props.options.at(-1).type, "other");
    assert.equal(draft.form.fields.find(f => f.id === "fd_note").dataOnly, true);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
    assert.equal(p.verify(p.update).ok, true);
  });
}

it("uses source evidence after arbitrary template, field, label and code renaming", () => {
  let renamed = xmlWithoutDefault.replaceAll("fd_kind", "fd_renamed_choice_identifier").replaceAll("fd_note", "fd_renamed_note_identifier")
    .replaceAll("申请类型", "材料用途").replaceAll("independent-other-wrap", "another-source-identity").replaceAll("OT", "OTHER_CODE");
  for (const title of ["其他材料用途", "材料用途其他"]) {
    const { draft } = stages(renamed.replaceAll("其他材料用途", title));
    assert.equal(draft.form.fields.find(f => f.nativeOther).props.options.at(-1).type, "other");
    assert.equal(prepareSample(draft).verify(prepareSample(draft).update).ok, true);
  }
});

it("blocks the actual seal source when existing scripts read the changed Other choice", () => {
  const draft = draftSourceDraft(cleanSourceFile(sealFixture));
  assert.ok(checkDraft(draft).diagnostics.some(item => item.code === "source.form.native_other_checkbox_unproven"));
});

for (const [name, change] of [
  ["unrelated text title", text => text.replaceAll("其他申请类型", "联系电话")],
  ["explicit line break", text => text.replace("&lt;/table&gt;&lt;div fd_type", "&lt;/table&gt;&lt;br/&gt;&lt;div fd_type")],
  ["intentional zero text width", text => text.replaceAll('width:&quot;120&quot;', 'width:&quot;0&quot;').replaceAll('width:"120"', 'width:"0"').replaceAll('width:120px', 'width:0px')],
  ["Other is not the last option", text => text.replaceAll("财务事项|D", "TEMP_OPTION")
    .replaceAll("其他|OT", "财务事项|D").replaceAll("TEMP_OPTION", "其他|OT")]
]) it(`does not invent a same-line companion: ${name}`, () => {
  const { draft } = stages(change(xmlWithoutDefault));
  assert.deepEqual(companions(prepareSample(draft)), []);
});

for (const scene of ["desktop", "mobile"]) for (const [name, change] of [
  ["lost stylesheet", group => group.children.shift()],
  ["null field node", group => { group.children[1] = null; }],
  ["changed reservation", group => { group.children[0].controlProps.dangerouslySetInnerHTML.__html = group.children[0].controlProps.dangerouslySetInnerHTML.__html.replace("padding-right:", "padding-left:"); }],
  ["injected script", group => { group.children[0].controlProps.dangerouslySetInnerHTML.__html += "<script>throw new Error('unexpected')</script>"; }],
  ["hidden stylesheet", group => { group.children[0].controlProps.hidden = true; }],
  ["changed pair width", group => { group.controlProps.style["--mk-choice-other-note-width"] = "min(10px, 50%)"; }],
  ["removed grouping", group => { delete group.controlProps.className; }],
  ["reordered fields", group => { [group.children[1], group.children[2]] = [group.children[2], group.children[1]]; }]
]) it(`readback rejects ${scene} ${name}`, () => {
  const p = prepareSample(retainedLegacy()), changed = structuredClone(p.update);
  editView(changed, scene, root => change(nodes(root).find(n => n.controlProps?.className?.startsWith("mk-choice-other-flow-"))));
  assert.equal(p.verify(changed).ok, false);
});

it("retains unchanged native desktop/mobile source and stylesheet provenance", () => {
  const root = new URL("../fixtures/executor/persistence/choice-other-wrap/", import.meta.url);
  const provenance = JSON.parse(readFileSync(new URL("provenance.json", root)));
  for (const [name, evidence] of Object.entries(provenance.files)) assert.equal(
    createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex"), evidence.sha256, name);
});

it("replays the native desktop checkbox label and group selectors in layout fixtures", () => {
  const config = xformConfig(prepareSample(retainedLegacy()).update);
  const html = nativeChoiceLayoutHtml(config, "desktop");
  assert.match(html, /class="ele-xform-checkbox"/);
  assert.match(html, /class="lui-checkbox-group ele-xform-checkbox-group"/);
  assert.equal([...html.matchAll(/class="core-choice lui-checkbox-wrapper ele-checkbox"/g)].length, 5);
  assert.match(html, /\.ele-xform-checkbox \.lui-checkbox-group \.lui-checkbox-wrapper\{[^}]*display:flex/);
});

it("keeps Other and its original textbox together after real native option wrapping", {
  skip: process.env.MK_LAYOUT_BROWSER_TESTS !== "1"
}, async () => {
  const { chromium } = await import(process.env.MK_LAYOUT_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MK_LAYOUT_BROWSER_PATH });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    for (const kind of ["Checkbox", "Radio"]) for (const sizing of ["adaptive", "source"]) for (const alignment of ["H", "V"]) for (const scene of ["desktop", "mobile"]) {
      const { draft } = stages(xml.replaceAll("inputCheckbox", `input${kind}`)
        .replaceAll("xform:checkbox", `xform:${kind.toLowerCase()}`).replaceAll('alignment:"H"', `alignment:"${alignment}"`)
        .replaceAll('alignment="H"', `alignment="${alignment}"`), { layoutSizing: sizing });
      const config = xformConfig(prepareSample(draft).update);
      await page.setContent(nativeChoiceLayoutHtml(config, scene));
      await page.locator('[data-value="OT"] input').check();
      for (const width of [900, 550, 400, 320, 240, 180]) {
        await page.setViewportSize({ width, height: 900 });
        const rects = await page.evaluate(() => {
          const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          return { options: [...document.querySelectorAll(".core-choice")].map(rect),
            other: rect(document.querySelector('[data-value="OT"] .ele-item-text')),
            note: rect(document.querySelector("input[data-note]")), scrollWidth: document.body.scrollWidth };
        });
        const { other, note } = rects, label = `${kind}/${sizing}/${alignment}/${scene}/${width}`;
        if (width === 900) {
          const firstLineShared = Math.abs(rects.options[0].y - rects.options[1].y) < 2;
          assert.equal(firstLineShared, alignment === "H",
            `${label}: native option rows must preserve source H/V direction: ${JSON.stringify(rects)}`);
        }
        assert.ok(Math.min(other.y + other.height, note.y + note.height) - Math.max(other.y, note.y) >= Math.min(other.height, note.height) / 2,
          `${label}: Other and textbox must share a rendered line: ${JSON.stringify(rects)}`);
        assert.ok(note.x >= other.x + other.width && note.x - other.x - other.width <= 16,
          `${label}: textbox must immediately follow Other: ${JSON.stringify(rects)}`);
        assert.ok(note.width >= 60 && note.x + note.width <= width, `${label}: input must fit`);
        if (width <= 400) assert.ok(new Set(rects.options.map(r => r.y)).size > 1, "exercise actual wrapping");
      }
    }
    for (const path of [sealFixture,
      "tests/fixtures/route-validation/choice-other-companion-fidelity/main-checkbox-existing_SysFormTemplate.xml",
      "tests/fixtures/route-validation/checkbox-other-compatible/compatible_SysFormTemplate.xml"]) {
      const config = xformConfig(prepareSample(draftSourceDraft(cleanSourceFile(path))).update);
      for (const scene of ["desktop", "mobile"]) {
        await page.setContent(nativeChoiceLayoutHtml(config, scene));
        await page.evaluate(() => document.querySelectorAll('[class^="mk-choice-other-flow-"]').forEach(group => {
          const inputs = group.querySelectorAll(".mk-choice-other-choice input[type=checkbox], .mk-choice-other-choice input[type=radio]");
          if (inputs.length) inputs[inputs.length - 1].checked = true;
        }));
        for (const width of [900, 400, 240, 180]) {
          await page.setViewportSize({ width, height: 900 });
          const pairs = await page.evaluate(() => [...document.querySelectorAll('[class^="mk-choice-other-flow-"]')].map(group => {
            const choice = group.querySelector(".mk-choice-other-choice"), note = group.querySelector("input[data-note]");
            const text = [...choice.querySelectorAll(".ele-item-text")].at(-1) || choice;
            const r = text.getBoundingClientRect(), n = note.getBoundingClientRect();
            return { yOverlap: Math.min(r.bottom, n.bottom) - Math.max(r.top, n.top),
              gap: n.left - r.right, noteWidth: n.width, right: n.right };
          }));
          assert.ok(pairs.length, "source must exercise an actual compound native layout");
          for (const pair of pairs) {
            assert.ok(pair.yOverlap >= 8 && pair.gap >= 0 && pair.gap <= 28 && pair.noteWidth >= 40 && pair.right <= width,
              `${path}/${scene}/${width}: ${JSON.stringify(pair)}`);
          }
        }
      }
    }
  } finally { await browser.close(); }
});
