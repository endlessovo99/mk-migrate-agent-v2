import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateMigrationDsl } from "../../src/dsl/schema.js";
import { sampleForm, sampleTrustedDsl } from "../helpers/sample-dsl.js";
import { persistAndVerify, xformConfig } from "../helpers/persistence.js";

describe("detail single-select row options", () => {
  it("accepts only same-row, same-table static option subsets", () => {
    const valid = detailRowOptionsDsl();
    assert.equal(validateMigrationDsl(valid, { mode: "execute" }).ok, true);

    const arbitraryNativeJs = structuredClone(valid);
    arbitraryNativeJs.form.fields[2].columns[1].props.optionSource = "JavaScript";
    arbitraryNativeJs.form.fields[2].columns[1].props.js = "alert(1)";
    assert.equal(
      validateMigrationDsl(arbitraryNativeJs, { mode: "execute" }).diagnostics
        .filter((item) => item.code === "catalog.props.unknown").length,
      2
    );

    const mainField = structuredClone(valid);
    mainField.form.fields[0] = {
      ...structuredClone(mainField.form.fields[2].columns[1]),
      id: "fd_main_part",
      sourceRef: "source.form.control.fd_main_part"
    };
    assert.equal(
      validateMigrationDsl(mainField, { mode: "execute" }).diagnostics.some((item) =>
        item.code === "dsl.field.row_options_scope_invalid"
      ),
      true
    );

    const invalid = structuredClone(valid);
    const target = invalid.form.fields[2].columns[1];
    target.props.rowOptions.dependencyFieldId = target.id;
    target.props.rowOptions.cases.push({
      value: "STD",
      options: [{ label: "Not static", value: "NOT_STATIC" }]
    });
    target.props.rowOptions.defaultOptions = [
      { label: "Static label drift", value: "STD_A" }
    ];
    const diagnostics = validateMigrationDsl(invalid, { mode: "execute" }).diagnostics;

    assert.equal(
      diagnostics.some((item) => item.code === "dsl.field.row_options_dependency_self"),
      true
    );
    assert.equal(
      diagnostics.some((item) => item.code === "dsl.field.row_options_case_value_duplicate"),
      true
    );
    assert.equal(
      diagnostics.filter((item) => item.code === "dsl.field.row_options_option_not_static").length,
      2
    );
  });

  it("persists canonical row-scoped JavaScript and independently verifies its exact semantics", () => {
    const dsl = detailRowOptionsDsl();
    const { template, readback } = persistAndVerify(dsl);
    const { detailModel, targetControl } = nativeRowOptionsEvidence(template);
    const dependencyRef = `${detailModel.fdTableName}.fd_kind`;
    const expectedJs =
      `function (controlProps, rowNum, MKXFORM) {var cases=[{"value":"STD","options":[{"label":"Standard A","value":"STD_A"}]},{"value":"BLADE","options":[{"label":"Blade B","value":"BLADE_B"}]}];var defaultOptions=[{"label":"Standard A","value":"STD_A"},{"label":"Blade B","value":"BLADE_B"}];var value=MKXFORM.getValue(${JSON.stringify(dependencyRef)},{detailRowIndex:rowNum});var options=defaultOptions;for(var index=0;index<cases.length;index+=1){if(cases[index].value===String(value)){options=cases[index].options;break;}}return {options:options,deps:[${JSON.stringify(dependencyRef)}]};}`;

    assert.equal(targetControl.optionSource, "JavaScript");
    assert.equal(targetControl.js, expectedJs);
    assert.deepEqual(targetControl.options, [
      { label: "Standard A", value: "STD_A" },
      { label: "Blade B", value: "BLADE_B" }
    ]);
    assert.equal(targetControl.js.includes("setProps"), false);
    assert.equal(readback.ok, true, JSON.stringify(readback.diagnostics));
    assert.deepEqual(
      readback.form.fields
        .find((field) => field.id === "fd_detail")
        .columns.find((column) => column.id === "fd_part")
        .rowOptions,
      {
        dependencyFieldId: "fd_kind",
        dependencyRef,
        cases: [
          {
            value: "STD",
            options: [{ label: "Standard A", value: "STD_A" }]
          },
          {
            value: "BLADE",
            options: [{ label: "Blade B", value: "BLADE_B" }]
          }
        ],
        defaultOptions: [
          { label: "Standard A", value: "STD_A" },
          { label: "Blade B", value: "BLADE_B" }
        ],
        optionSource: "JavaScript",
        jsDigest: readback.form.fields
          .find((field) => field.id === "fd_detail")
          .columns.find((column) => column.id === "fd_part")
          .rowOptions.jsDigest
      }
    );
    assert.match(
      readback.form.fields
        .find((field) => field.id === "fd_detail")
        .columns.find((column) => column.id === "fd_part")
        .rowOptions.jsDigest,
      /^[a-f0-9]{32}$/u
    );
  });

  for (const mutation of [
    {
      name: "optionSource changes",
      mutate(control) {
        control.optionSource = "Static";
      }
    },
    {
      name: "optionSource gains surrounding whitespace",
      mutate(control) {
        control.optionSource = " JavaScript ";
      }
    },
    {
      name: "one dependency changes",
      mutate(control) {
        control.js = control.js.replace(
          /deps:\[[^\]]+\]/u,
          'deps:["wrong_table.fd_kind"]'
        );
      }
    },
    {
      name: "one case option changes",
      mutate(control) {
        control.js = control.js.replace("Standard A", "Tampered A");
      }
    }
  ]) {
    it(`fails closed when ${mutation.name}`, () => {
      const { readback } = persistAndVerify(detailRowOptionsDsl(), {
        mutate(template) {
          const {
            config,
            target,
            targetAttribute,
            targetControl
          } = nativeRowOptionsEvidence(template);
          mutation.mutate(targetControl);
          target.fdAttribute = JSON.stringify(targetAttribute);
          template.mechanisms["sys-xform"].fdConfig = JSON.stringify(config);
          return template;
        }
      });

      assert.equal(readback.ok, false);
      assert.equal(readback.partitions.form, "mismatch");
      assert.equal(
        readback.diagnostics.some((item) =>
          item.code === "readback.form.prop_rowOptions_mismatch"
        ),
        true
      );
    });
  }
});

function detailRowOptionsDsl() {
  const form = sampleForm();
  const detail = form.fields.find((field) => field.id === "fd_detail");
  detail.columns = [
    {
      id: "fd_kind",
      title: "Kind",
      type: "singleSelect",
      componentId: "xform-select",
      props: {
        options: [
          { label: "Standard", value: "STD" },
          { label: "Blade", value: "BLADE" }
        ]
      },
      sourceProps: { metadataKind: "options" },
      sourceRef: "source.form.detailTable.fd_detail.column.fd_kind"
    },
    {
      id: "fd_part",
      title: "Part",
      type: "singleSelect",
      componentId: "xform-select",
      props: {
        options: [
          { label: "Standard A", value: "STD_A" },
          { label: "Blade B", value: "BLADE_B" }
        ],
        rowOptions: {
          dependencyFieldId: "fd_kind",
          cases: [
            {
              value: "STD",
              options: [{ label: "Standard A", value: "STD_A" }]
            },
            {
              value: "BLADE",
              options: [{ label: "Blade B", value: "BLADE_B" }]
            }
          ],
          defaultOptions: [
            { label: "Standard A", value: "STD_A" },
            { label: "Blade B", value: "BLADE_B" }
          ]
        }
      },
      sourceProps: { metadataKind: "options" },
      sourceRef: "source.form.detailTable.fd_detail.column.fd_part"
    }
  ];
  const dsl = sampleTrustedDsl({ form });
  delete dsl.workflow;
  return dsl;
}

function nativeRowOptionsEvidence(template) {
  const config = xformConfig(template);
  const detailModel = config.dataModel.find((model) =>
    model.fdType === "detail" && model.dynamicProps?.detailFieldName === "fd_detail"
  );
  const target = detailModel.fdFields.find((field) => field.fdName === "fd_part");
  const targetAttribute = JSON.parse(target.fdAttribute);
  const targetControl = targetAttribute.config.controlProps;
  return { config, detailModel, target, targetAttribute, targetControl };
}
