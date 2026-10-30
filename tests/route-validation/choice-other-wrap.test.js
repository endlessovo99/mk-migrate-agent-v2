import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { cleanSourceFile, draftSourceDraft } from "../../src/translator/index.js";
import { checkTrust, createTrustedMigrationDsl } from "../../src/dsl/trust.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";
import { nativeChoiceLayoutHtml } from "../helpers/native-choice-layout.js";

const fixture = "tests/fixtures/route-validation/choice-other-wrap/choice-other-wrap_SysFormTemplate.xml";
const sealFixture = "tests/fixtures/source3/166d859bc79f49f5acf97474d9fa5d85/166d86064d2c8b3955ffad64e8eba196_SysFormTemplate.xml";
const xml = readFileSync(fixture, "utf8");
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

it("recognizes an adjacent prefix Other title and retains independent field semantics", () => {
  const { source, draft } = stages();
  const choice = draft.form.fields.find(f => f.id === "fd_kind");
  const note = draft.form.fields.find(f => f.id === "fd_note");
  assert.equal(choice.sourceProps.otherTextCompanion?.id, note.id);
  assert.equal(choice.sourceProps.otherTextCompanion.optionValue, "OT");
  assert.deepEqual(choice.props.options, source.form.controls.find(f => f.id === choice.id).options);
  assert.ok(choice.props.options.every(o => o.type !== "other"));
  assert.notEqual(note.dataOnly, true);
  assert.equal(note.props.defaultValue.value, "  seed_under_score🙂  ");
  assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
  const p = prepareSample(draft);
  assert.equal(p.verify(p.update).ok, true);
});

for (const sizing of ["adaptive", "source"]) for (const kind of ["Checkbox", "Radio"]) {
  it(`preserves a generic independent ${kind} companion through ${sizing} projection and readback`, () => {
    const { source, draft } = stages(xml.replaceAll("inputCheckbox", `input${kind}`).replaceAll("xform:checkbox", `xform:${kind.toLowerCase()}`), { layoutSizing: sizing });
    const p = prepareSample(draft), result = p.verify(p.update);
    assert.equal(checkTrust(source, createTrustedMigrationDsl(source, draft, { externalAgentReviewed: true })).ok, true);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(companions(p), [{ lineIndex: 0, referenceIds: ["fd_kind", "fd_note"], mode: "tail", width: { value: 120, unit: "px" }, revealOnSelection: true }]);
    const changed = structuredClone(p.update);
    for (const scene of ["desktop", "mobile"]) editView(changed, scene, root => {
      for (const node of nodes(root)) for (const key of Object.keys(node)) if (key.startsWith("migration")) delete node[key];
    });
    assert.equal(p.verify(changed).ok, true, "actual hierarchy and CSS establish adjacency without audit markers");
  });
}

it("uses source evidence after arbitrary template, field, label and code renaming", () => {
  let renamed = xml.replaceAll("fd_kind", "fd_renamed_choice_identifier").replaceAll("fd_note", "fd_renamed_note_identifier")
    .replaceAll("申请类型", "材料用途").replaceAll("independent-other-wrap", "another-source-identity").replaceAll("OT", "OTHER_CODE");
  for (const title of ["其他材料用途", "材料用途其他"]) {
    const { draft } = stages(renamed.replaceAll("其他材料用途", title));
    const pair = companions(prepareSample(draft))[0];
    assert.deepEqual(pair.referenceIds, draft.form.fields.filter(f => ["checkbox", "text"].includes(f.type)).map(f => f.id));
  }
});

it("projects both companion patterns in the actual source behind the reported seal form", () => {
  const draft = draftSourceDraft(cleanSourceFile(sealFixture)), p = prepareSample(draft);
  assert.equal(p.verify(p.update).ok, true);
  const choice = draft.form.fields.find(f => f.title === "用印类型" && f.componentId === "xform-checkbox");
  const note = draft.form.fields.find(f => f.id === choice.sourceProps.otherTextCompanion.id);
  assert.equal(note.title, "其他用印类型");
  assert.ok(companions(p).some(pair => pair.mode === "tail" && pair.referenceIds.join() === [choice.id, note.id].join()));
  assert.ok(companions(p).some(pair => pair.mode === "caption"));
});

for (const [name, change] of [
  ["unrelated text title", text => text.replaceAll("其他申请类型", "联系电话")],
  ["explicit line break", text => text.replace("&lt;/table&gt;&lt;div fd_type", "&lt;/table&gt;&lt;br/&gt;&lt;div fd_type")],
  ["intentional zero text width", text => text.replaceAll('width:&quot;120&quot;', 'width:&quot;0&quot;').replaceAll('width:"120"', 'width:"0"').replaceAll('width:120px', 'width:0px')],
  ["Other is not the last option", text => text.replaceAll("财务事项|D", "TEMP_OPTION")
    .replaceAll("其他|OT", "财务事项|D").replaceAll("TEMP_OPTION", "其他|OT")]
]) it(`does not invent a same-line companion: ${name}`, () => {
  const { draft } = stages(change(xml));
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
  const p = prepareSample(stages().draft), changed = structuredClone(p.update);
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
  const config = xformConfig(prepareSample(stages().draft).update);
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
