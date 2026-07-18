import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { prepareSample, xformConfig } from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");
const nativeEvidence = JSON.parse(
  readFileSync(join(fixtureDir, "semantic-props-native-evidence.json"), "utf8")
);

describe("independent semantic native evidence", () => {
  it("writes number unit and workflow help to their independently evidenced native keys", () => {
    const prepared = prepareSample(semanticDsl());
    const number = nativeNumberEvidence(prepared.update, nativeEvidence.formControl.fieldId);
    const workflowNode = nativeWorkflowElements(prepared.update)
      .find((node) => node.id === nativeEvidence.workflowNode.id);

    assert.equal(number.controlProps.unit, undefined);
    assertNativeNumberUnit(number, nativeEvidence.formControl.unit);
    assertNativeNodeHelp(workflowNode, nativeEvidence.workflowNode.description);
  });

  it("restores number unit and workflow help from independent native readback", () => {
    const readback = prepareSample(semanticDsl()).verify(independentNativeReadback());

    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.equal(
      readback.form.fields.find((field) => field.id === nativeEvidence.formControl.fieldId).unit,
      nativeEvidence.formControl.unit
    );
    assert.equal(
      readback.workflow.nodes.find((node) => node.id === nativeEvidence.workflowNode.id).help,
      nativeEvidence.workflowNode.description
    );
  });

  for (const testCase of [
    {
      name: "missing unit",
      fieldId: "fd_amount",
      mutate(template) {
        mutateNativeNumberEvidence(template, "fd_amount", ({ controlProps }) => {
          delete controlProps.numberFormat.unit;
        });
      }
    },
    {
      name: "changed unit",
      fieldId: "fd_amount",
      mutate(template) {
        mutateNativeNumberEvidence(template, "fd_amount", ({ langEntry }) => {
          langEntry.content.Cn = "万元";
          langEntry.content.default = "万元";
        });
      }
    },
    {
      name: "unit on the wrong field",
      fieldId: "fd_amount",
      mutate(template) {
        mutateNativeNumberEvidence(template, "fd_amount", ({ langEntry }) => {
          langEntry.name = "fd_subject";
        });
      }
    },
    {
      name: "unit token missing from font metadata",
      fieldId: "fd_amount",
      mutate(template) {
        mutateNativeNumberEvidence(template, "fd_amount", ({ fontExtendData }) => {
          delete fontExtendData.unit;
        });
      }
    }
  ]) {
    it(`rejects ${testCase.name} with the precise field id`, () => {
      const template = independentNativeReadback();
      testCase.mutate(template);
      const readback = prepareSample(semanticDsl()).verify(template);

      assert.equal(readback.ok, false);
      const diagnostic = readback.diagnostics.find((item) =>
        item.code === "readback.form.prop_unit_mismatch" &&
        item.details?.fieldId === testCase.fieldId
      );
      assert.equal(diagnostic?.path, `/readback/form/fields/${testCase.fieldId}/props`);
      assert.equal(diagnostic?.details?.expected, nativeEvidence.formControl.unit);
    });
  }

  it("rejects malformed native unit JSON with a precise field path", () => {
    const template = independentNativeReadback();
    mutateNativeField(template, nativeEvidence.formControl.fieldId, (field) => {
      field.fdAttribute = "{not-json";
    });
    const readback = prepareSample(semanticDsl()).verify(template);
    const diagnostic = readback.diagnostics.find((item) =>
      item.code === "readback.decode.fdAttribute.invalid_json"
    );

    assert.equal(readback.ok, false);
    assert.equal(
      diagnostic?.path,
      `/mechanisms/sys-xform/fdConfig/dataModel/${nativeEvidence.formControl.fieldId}/fdAttribute`
    );
    assert.equal(diagnostic?.details?.fieldId, nativeEvidence.formControl.fieldId);
  });

  for (const testCase of [
    {
      name: "missing node help",
      mutate(elements) {
        removeNativeNodeHelp(elements.find((node) => node.id === "N2"));
      }
    },
    {
      name: "changed node help",
      mutate(elements) {
        setNativeNodeHelp(elements.find((node) => node.id === "N2"), "已被修改");
      }
    },
    {
      name: "missing localized node help mirror",
      mutate(elements) {
        delete elements.find((node) => node.id === "N2").language.descriptionCn;
      }
    },
    {
      name: "changed localized node help mirror",
      mutate(elements) {
        elements.find((node) => node.id === "N2").language.descriptionCn = "本地化帮助已被修改";
      }
    },
    {
      name: "help on the wrong node",
      mutate(elements) {
        removeNativeNodeHelp(elements.find((node) => node.id === "N2"));
        setNativeNodeHelp(
          elements.find((node) => node.id === "N3"),
          nativeEvidence.workflowNode.description
        );
      }
    }
  ]) {
    it(`rejects ${testCase.name} with the precise node id`, () => {
      const template = independentNativeReadback();
      const lbpm = template.mechanisms.lbpmTemplate[0];
      const content = JSON.parse(lbpm.fdContent);
      testCase.mutate(content.elements);
      lbpm.fdContent = JSON.stringify(content);
      const readback = prepareSample(semanticDsl()).verify(template);

      assert.equal(readback.ok, false);
      const diagnostic = readback.diagnostics.find((item) =>
        item.code === "readback.workflow.node_help_mismatch" &&
        item.details?.nodeId === nativeEvidence.workflowNode.id
      );
      assert.equal(diagnostic?.path, `/readback/workflow/nodes/${nativeEvidence.workflowNode.id}/help`);
      assert.equal(diagnostic?.details?.expected, nativeEvidence.workflowNode.description);
    });
  }

  it("rejects malformed native workflow JSON at the fdContent path", () => {
    const template = independentNativeReadback();
    template.mechanisms.lbpmTemplate[0].fdContent = "{not-json";
    const readback = prepareSample(semanticDsl()).verify(template);
    const diagnostic = readback.diagnostics.find((item) =>
      item.code === "readback.decode.fdContent.invalid_json"
    );

    assert.equal(readback.ok, false);
    assert.equal(diagnostic?.path, "/mechanisms/lbpmTemplate/0/fdContent");
    assert.equal(typeof diagnostic?.details?.reason, "string");
  });
});

function semanticDsl() {
  const dsl = sampleTrustedDsl();
  const amount = dsl.form.fields.find((field) => field.id === nativeEvidence.formControl.fieldId);
  amount.type = "number";
  amount.componentId = "xform-number";
  amount.props.unit = nativeEvidence.formControl.unit;
  dsl.workflow = {
    process: { id: "semantic-process" },
    nodes: [
      { id: "N1", type: "generalStart", element: "startEvent", name: "开始", sourceRef: "source.workflow.node.N1", attributes: {}, translationStatus: "executable" },
      { id: "N2", type: "draft", element: "manualTask", name: "起草节点", help: nativeEvidence.workflowNode.description, sourceRef: "source.workflow.node.N2", attributes: {}, translationStatus: "executable" },
      { id: "N3", type: "generalEnd", element: "endEvent", name: "结束", sourceRef: "source.workflow.node.N3", attributes: {}, translationStatus: "executable" }
    ],
    edges: [
      { id: "L1", source: "N1", target: "N2", sourceRef: "source.workflow.edge.L1", condition: { translationStatus: "executable" } },
      { id: "L2", source: "N2", target: "N3", sourceRef: "source.workflow.edge.L2", condition: { translationStatus: "executable" } }
    ],
    topologicalOrder: ["N1", "N2", "N3"]
  };
  return dsl;
}

function independentNativeReadback() {
  const template = JSON.parse(
    readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8")
  );
  const config = xformConfig(template);
  const formAttr = JSON.parse(config.attribute.formAttr);
  formAttr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(formAttr);

  const amount = config.dataModel.find((model) => model.fdType === "main")
    .fdFields.find((field) => field.fdName === nativeEvidence.formControl.fieldId);
  const amountAttribute = JSON.parse(amount.fdAttribute);
  amount.fdType = "number";
  amount.fdDataType = "number";
  amountAttribute.config.type = "@elem/xform-number";
  amountAttribute.config.controlProps.desktop.type = "@elem/xform-number";
  amountAttribute.config.controlProps.mobile.type = "@elem/xform-m-number";
  Object.assign(amountAttribute.config.controlProps, nativeEvidence.formControl.controlProps);
  delete amountAttribute.config.controlProps.unit;
  amount.fdAttribute = JSON.stringify(amountAttribute);
  amount.fdFontExtendData = JSON.stringify(nativeEvidence.formControl.fontExtendData);
  config.lang = JSON.stringify({
    [nativeEvidence.formControl.unitToken]: nativeEvidence.formControl.langEntry
  });
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

  const workflowElements = [
    { id: "N1", name: "开始", type: "generalStart", element: "startEvent" },
    { ...nativeEvidence.workflowNode },
    { id: "N3", name: "结束", type: "generalEnd", element: "endEvent" },
    { id: "L1", type: "sequenceFlow", sourceRef: "N1", targetRef: "N2" },
    { id: "L2", type: "sequenceFlow", sourceRef: "N2", targetRef: "N3" }
  ];
  template.mechanisms.lbpmTemplate = [{
    fdId: "workflow-template-id",
    fdStatus: "draft",
    latestDefinitionStatus: 0,
    isDraft: true,
    fdTemplateForms: [],
    fdContent: JSON.stringify({ elements: workflowElements })
  }];
  return template;
}

function nativeNumberEvidence(template, fieldId) {
  const config = xformConfig(template);
  const field = config.dataModel.flatMap((model) => model.fdFields || [])
    .find((candidate) => candidate.fdName === fieldId);
  const controlProps = JSON.parse(field.fdAttribute).config.controlProps;
  const fontExtendData = JSON.parse(field.fdFontExtendData);
  const lang = JSON.parse(config.lang || "{}");
  const unitToken = controlProps.numberFormat?.unit;
  return {
    config,
    field,
    controlProps,
    fontExtendData,
    lang,
    unitToken,
    langEntry: lang[unitToken]
  };
}

function assertNativeNumberUnit(number, unit) {
  assert.match(number.unitToken, /^!\{[^}]+\}$/);
  assert.equal(number.fontExtendData.unit, number.unitToken);
  assert.equal(number.controlProps.numberFormat.formatType, "base");
  assert.equal(number.fontExtendData.formatType, "base");
  assert.deepEqual(number.langEntry, {
    prop: "numberFormat",
    name: number.field.fdName,
    type: "input",
    content: { Cn: unit, default: unit }
  });
}

function mutateNativeNumberEvidence(template, fieldId, mutate) {
  const evidence = nativeNumberEvidence(template, fieldId);
  mutate(evidence);
  const attribute = JSON.parse(evidence.field.fdAttribute);
  attribute.config.controlProps = evidence.controlProps;
  evidence.field.fdAttribute = JSON.stringify(attribute);
  evidence.field.fdFontExtendData = JSON.stringify(evidence.fontExtendData);
  evidence.config.lang = JSON.stringify(evidence.lang);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(evidence.config);
}

function mutateNativeField(template, fieldId, mutate) {
  const config = xformConfig(template);
  const field = config.dataModel.flatMap((model) => model.fdFields || [])
    .find((candidate) => candidate.fdName === fieldId);
  mutate(field);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
}

function nativeWorkflowElements(template) {
  return JSON.parse(template.mechanisms.lbpmTemplate[0].fdContent).elements;
}

function assertNativeNodeHelp(node, help) {
  assert.equal(node.description, help);
  assert.equal(node.language.descriptionCn, help);
}

function removeNativeNodeHelp(node) {
  delete node.description;
  if (node.language) delete node.language.descriptionCn;
}

function setNativeNodeHelp(node, help) {
  node.description = help;
  node.language = {
    ...(node.language || {}),
    descriptionCn: help
  };
}
