import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFormRuleRefIndex,
  resolveEffectTarget,
  resolveRowMarkerControlIds
} from "../../src/dsl/form-rules.js";

describe("nested-layout form-rule references", () => {
  it("recursively resolves a parent row marker to descendant leaf controls", () => {
    const form = {
      fields: [
        { id: "fd_heading", type: "description" },
        { id: "fd_alpha", type: "text" },
        { id: "fd_bravo", type: "text" }
      ],
      layout: {
        mkTree: [
          {
            id: "layout.parent",
            sourceRef: "source.form.layout.row.parent",
            sourceMarkers: ["parent_row"],
            children: [
              { refType: "field", refIds: ["fd_heading"] },
              {
                refType: "layout",
                refIds: ["layout.nested.alpha", "layout.nested.bravo"]
              }
            ]
          },
          {
            id: "layout.nested.alpha",
            sourceRef: "source.form.layout.row.nested-alpha",
            children: [{ refType: "field", refIds: ["fd_alpha"] }]
          },
          {
            id: "layout.nested.bravo",
            sourceRef: "source.form.layout.row.nested-bravo",
            children: [{ refType: "field", refIds: ["fd_bravo"] }]
          }
        ]
      }
    };

    assert.deepEqual(
      resolveEffectTarget(buildFormRuleRefIndex(form), "parent_row")?.targets.map((target) => target.id),
      ["fd_heading", "fd_alpha", "fd_bravo"]
    );
    assert.deepEqual(
      resolveRowMarkerControlIds(form, "parent_row"),
      ["fd_heading", "fd_alpha", "fd_bravo"]
    );
  });
});
