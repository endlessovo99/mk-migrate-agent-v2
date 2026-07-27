import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sampleTrustedDsl } from "../helpers/sample-dsl.js";
import {
  prepareSample,
  projectTemplate,
  xformConfig
} from "../helpers/persistence.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/executor/persistence");

describe("workflow detail-table data authority", () => {
  it("keeps inherited sibling columns and row operations available for sparse overrides", () => {
    const dsl = detailAuthorityDsl({
      fd_name: hiddenAuthority()
    });
    const payload = projectTemplate(dsl);
    const { auth, tableName } = nativeDetailAuthority(payload);
    const operations = operationState(auth[tableName].operations);

    assert.deepEqual(auth[`${tableName}.fd_name`], {
      isShow: false,
      isEdit: false,
      isRequire: false
    });
    assert.deepEqual(auth[tableName], {
      isShow: true,
      isEdit: true,
      isRequire: false,
      operations: auth[tableName].operations
    });
    assert.deepEqual(operations, {
      canAddRow: true,
      canDeleteRow: true,
      canImport: true,
      canExport: false
    });
  });

  it("hides a detail table only when every column is explicitly hidden", () => {
    const dsl = detailAuthorityDsl({
      fd_name: hiddenAuthority(),
      fd_code: hiddenAuthority()
    });
    const payload = projectTemplate(dsl);
    const { auth, tableName } = nativeDetailAuthority(payload);

    assert.equal(auth[tableName].isShow, false);
    assert.equal(auth[tableName].isEdit, false);
    assert.deepEqual(operationState(auth[tableName].operations), {
      canAddRow: false,
      canDeleteRow: false,
      canImport: false,
      canExport: true
    });
  });

  it("keeps a fully explicit view-only detail table visible without edit operations", () => {
    const viewOnly = { visible: true, editable: false, required: false };
    const dsl = detailAuthorityDsl({
      fd_name: viewOnly,
      fd_code: viewOnly
    });
    const payload = projectTemplate(dsl);
    const { auth, tableName } = nativeDetailAuthority(payload);

    assert.equal(auth[tableName].isShow, true);
    assert.equal(auth[tableName].isEdit, false);
    assert.deepEqual(operationState(auth[tableName].operations), {
      canAddRow: false,
      canDeleteRow: false,
      canImport: false,
      canExport: true
    });
  });

  it("rejects the sanitized native sparse-authority repro until its table aggregate is corrected", () => {
    const prepared = prepareSample(detailAuthorityDsl({
      fd_name: hiddenAuthority()
    }));
    const brokenNative = independentNativeDetailAuthorityReadback();
    const broken = prepared.verify(brokenNative);

    assert.equal(broken.ok, false);
    assert.equal(broken.partitions.workflow, "mismatch");
    assert.equal(
      broken.diagnostics.some((item) =>
        item.code === "readback.workflow.data_authority_mismatch"
      ),
      true,
      JSON.stringify(broken.diagnostics)
    );

    const correctedNative = independentNativeDetailAuthorityReadback();
    const { auth, tableName } = nativeDetailAuthority(correctedNative);
    auth[tableName].isShow = true;
    auth[tableName].isEdit = true;
    auth[tableName].operations = JSON.stringify(
      JSON.parse(auth[tableName].operations).map((operation) => ({
        ...operation,
        enable: operation.id !== "canExport"
      }))
    );
    const corrected = prepared.verify(correctedNative);

    assert.equal(corrected.ok, true, JSON.stringify(corrected.diagnostics));
    assert.equal(corrected.partitions.workflow, "verified");
  });

  it("rejects readback that mutates the derived detail-table visibility", () => {
    const prepared = prepareSample(detailAuthorityDsl({
      fd_name: hiddenAuthority()
    }));
    const mutated = structuredClone(prepared.update);
    const { auth, tableName } = nativeDetailAuthority(mutated);
    auth[tableName].isShow = false;

    const readback = prepared.verify(mutated);

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.workflow.data_authority_mismatch"
      ),
      true
    );
  });

  it("rejects readback that mutates derived detail-table row operations", () => {
    const prepared = prepareSample(detailAuthorityDsl({
      fd_name: hiddenAuthority()
    }));
    const mutated = structuredClone(prepared.update);
    const { auth, tableName } = nativeDetailAuthority(mutated);
    const operations = JSON.parse(auth[tableName].operations);
    operations.find((operation) => operation.id === "canAddRow").enable = false;
    auth[tableName].operations = JSON.stringify(operations);

    const readback = prepared.verify(mutated);

    assert.equal(readback.ok, false);
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.workflow.data_authority_mismatch"
      ),
      true
    );
  });

  it("rejects a detail-column authority rebound to the wrong physical table", () => {
    const prepared = prepareSample(detailAuthorityDsl({
      fd_name: hiddenAuthority()
    }));
    const mutated = structuredClone(prepared.update);
    const { auth, tableName } = nativeDetailAuthority(mutated);
    const correctKey = `${tableName}.fd_name`;
    auth["wrong_table.fd_name"] = auth[correctKey];
    delete auth[correctKey];

    const readback = prepared.verify(mutated);

    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.workflow, "mismatch");
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.workflow.data_authority_mismatch"
      ),
      true
    );
  });

  it("rejects unexpected authority on a node whose DSL has none", () => {
    const prepared = prepareSample(detailAuthorityDsl({
      fd_name: hiddenAuthority()
    }));
    const mutated = structuredClone(prepared.update);
    mutated.mechanisms.lbpmTemplate[0].fdTemplateFormAuths.N1 = {
      fd_subject: {
        isShow: false,
        isEdit: false,
        isRequire: false
      }
    };

    const readback = prepared.verify(mutated);

    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.workflow, "mismatch");
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.workflow.data_authority_mismatch" &&
        item.invariantKey === "workflow.nodes.N1.dataAuthority"
      ),
      true,
      JSON.stringify(readback.diagnostics)
    );
  });

  it("fails closed on duplicate canonical detail-column authority keys", () => {
    const prepared = prepareSample(detailAuthorityDsl({
      fd_name: hiddenAuthority()
    }));
    const mutated = structuredClone(prepared.update);
    const { auth, tableName } = nativeDetailAuthority(mutated);
    auth["wrong_table.fd_name"] = structuredClone(auth[`${tableName}.fd_name`]);

    const readback = prepared.verify(mutated);

    assert.equal(readback.ok, false);
    assert.equal(readback.partitions.workflow, "decode_failed");
    assert.equal(
      readback.diagnostics.some((item) =>
        item.code === "readback.decode.workflow.data_authority.field_id_duplicate"
      ),
      true
    );
  });

  for (const invalidFormAuths of ["invalid", [], 1]) {
    it(`fails closed on wrong-typed fdTemplateFormAuths (${typeof invalidFormAuths})`, () => {
      const prepared = prepareSample(detailAuthorityDsl({
        fd_name: hiddenAuthority()
      }));
      const mutated = structuredClone(prepared.update);
      mutated.mechanisms.lbpmTemplate[0].fdTemplateFormAuths = invalidFormAuths;

      const readback = prepared.verify(mutated);

      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.workflow, "decode_failed");
      assert.equal(
        readback.diagnostics.some((item) =>
          item.code ===
            "readback.decode.workflow.data_authority.form_auths_object_required"
        ),
        true,
        JSON.stringify(readback.diagnostics)
      );
    });
  }

  for (const testCase of [
    {
      name: "wrong-typed table flag",
      code: "readback.decode.workflow.data_authority.boolean_wrong_type",
      mutate(auth, tableName) {
        auth[tableName].isShow = "garbage";
      }
    },
    {
      name: "malformed operations JSON",
      code: "readback.decode.workflow.data_authority.operations_invalid_json",
      mutate(auth, tableName) {
        auth[tableName].operations = "{";
      }
    },
    {
      name: "unknown operation id",
      code: "readback.decode.workflow.data_authority.operation_id_unknown",
      mutate(auth, tableName) {
        const operations = JSON.parse(auth[tableName].operations);
        operations.push({ id: "canRewriteHistory", enable: true });
        auth[tableName].operations = JSON.stringify(operations);
      }
    },
    {
      name: "whitespace-normalized operation id",
      code: "readback.decode.workflow.data_authority.operation_id_invalid",
      mutate(auth, tableName) {
        const operations = JSON.parse(auth[tableName].operations);
        operations[0].id = ` ${operations[0].id} `;
        auth[tableName].operations = JSON.stringify(operations);
      }
    },
    {
      name: "duplicate operation id",
      code: "readback.decode.workflow.data_authority.operation_id_duplicate",
      mutate(auth, tableName) {
        const operations = JSON.parse(auth[tableName].operations);
        operations.push({ ...operations[0] });
        auth[tableName].operations = JSON.stringify(operations);
      }
    }
  ]) {
    it(`fails closed on ${testCase.name}`, () => {
      const prepared = prepareSample(detailAuthorityDsl({
        fd_name: hiddenAuthority()
      }));
      const mutated = structuredClone(prepared.update);
      const { auth, tableName } = nativeDetailAuthority(mutated);
      testCase.mutate(auth, tableName);

      const readback = prepared.verify(mutated);

      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.workflow, "decode_failed");
      assert.equal(
        readback.diagnostics.some((item) => item.code === testCase.code),
        true,
        JSON.stringify(readback.diagnostics)
      );
    });
  }
});

function detailAuthorityDsl(fields) {
  const dsl = sampleTrustedDsl();
  const detail = dsl.form.fields.find((field) => field.id === "fd_detail");
  detail.columns.push({
    id: "fd_code",
    title: "编码",
    type: "text",
    componentId: "xform-input",
    props: {},
    sourceRef: "source.form.detailTable.fd_detail.column.fd_code",
    generated: false
  });
  dsl.workflow = {
    process: { id: "process-detail-authority" },
    nodes: [
      {
        id: "N1",
        type: "generalStart",
        element: "startEvent",
        name: "开始",
        sourceType: "startNode",
        sourceRef: "source.workflow.node.N1",
        attributes: {},
        translationStatus: "executable"
      },
      {
        id: "N2",
        type: "review",
        element: "manualTask",
        name: "明细权限节点",
        sourceType: "reviewNode",
        sourceRef: "source.workflow.node.N2",
        attributes: {},
        translationStatus: "executable",
        dataAuthority: {
          enabled: true,
          fields
        }
      },
      {
        id: "N3",
        type: "generalEnd",
        element: "endEvent",
        name: "结束",
        sourceType: "endNode",
        sourceRef: "source.workflow.node.N3",
        attributes: {},
        translationStatus: "executable"
      }
    ],
    edges: [
      {
        id: "L1",
        source: "N1",
        target: "N2",
        name: "",
        sourceRef: "source.workflow.edge.L1",
        attributes: {},
        condition: {
          sourceText: "",
          displayText: "",
          targetText: "",
          translationStatus: "executable"
        }
      },
      {
        id: "L2",
        source: "N2",
        target: "N3",
        name: "",
        sourceRef: "source.workflow.edge.L2",
        attributes: {},
        condition: {
          sourceText: "",
          displayText: "",
          targetText: "",
          translationStatus: "executable"
        }
      }
    ],
    topologicalOrder: ["N1", "N2", "N3"]
  };
  return dsl;
}

function hiddenAuthority() {
  return {
    visible: false,
    editable: false,
    required: false
  };
}

function nativeDetailAuthority(template) {
  const detailModel = xformConfig(template).dataModel.find((model) =>
    model.fdType === "detail" &&
    model.dynamicProps?.detailFieldName === "fd_detail"
  );
  assert.ok(detailModel);
  const node = template.mechanisms.lbpmTemplate[0].fdTemplateFormAuths.N2;
  assert.ok(node);
  return {
    auth: node,
    tableName: detailModel.fdTableName
  };
}

function operationState(value) {
  return Object.fromEntries(
    JSON.parse(value).map((operation) => [operation.id, operation.enable])
  );
}

function independentNativeDetailAuthorityReadback() {
  const template = JSON.parse(
    readFileSync(join(fixtureDir, "form-only-native-readback.json"), "utf8")
  );
  const config = xformConfig(template);
  const formAttr = JSON.parse(config.attribute.formAttr);
  formAttr.subjectRule = {};
  config.attribute.formAttr = JSON.stringify(formAttr);

  const detailModel = config.dataModel.find((model) =>
    model.fdType === "detail" &&
    model.dynamicProps?.detailFieldName === "fd_detail"
  );
  const nameField = detailModel.fdFields.find((field) => field.fdName === "fd_name");
  const codeField = structuredClone(nameField);
  codeField.fdId = "native-detail-code-field-id";
  codeField.fdLabel = "编码";
  codeField.fdName = "fd_code";
  codeField.fdOrder = 2;
  const codeAttribute = JSON.parse(codeField.fdAttribute);
  codeAttribute.uuid = "fd_code";
  codeAttribute.config.key = "@elem/xform-input~native-code";
  codeAttribute.config.controlProps.id = "@elem/xform-input~native-code";
  codeAttribute.config.controlProps.name = "fd_code";
  codeAttribute.config.controlProps.uuid = "fd_code";
  codeAttribute.config.controlProps.title = "编码";
  codeAttribute.config.label = "编码";
  codeAttribute.config.labelProps.title = "编码";
  codeField.fdAttribute = JSON.stringify(codeAttribute);
  detailModel.fdFields.splice(1, 0, codeField);
  template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);

  const workflow = JSON.parse(
    readFileSync(join(fixtureDir, "workflow-detail-authority-native.json"), "utf8")
  );
  template.mechanisms.lbpmTemplate[0].fdContent = JSON.stringify(workflow.fdContent);
  template.mechanisms.lbpmTemplate[0].fdTemplateFormAuths =
    workflow.fdTemplateFormAuths;
  return template;
}
