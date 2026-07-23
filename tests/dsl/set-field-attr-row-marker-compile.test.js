import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileSetFieldAttrRowMarkerTargets } from "../../src/dsl/scripts.js";

describe("compileSetFieldAttrRowMarkerTargets", () => {
  it("expands multi-control row markers as ASI-safe statements, not paren comma expressions", () => {
    const form = {
      fields: [
        { id: "fd_a", type: "text" },
        { id: "fd_b", type: "text" },
        { id: "fd_trigger", type: "radio" }
      ],
      layout: {
        mkTree: [{
          id: "layout.row-1",
          sourceRef: "source.form.layout.row.row-1",
          sourceMarkers: ["fd_pair_row"],
          children: [
            { refId: "fd_a" },
            { refId: "fd_b" }
          ]
        }]
      }
    };

    const source = [
      "function onLoad() {",
      "  MKXFORM.setValue(\"fd_trigger\", \"x\")",
      "  MKXFORM.setFieldAttr(\"fd_pair_row\", 4)",
      "  MKXFORM.setFieldAttr(\"fd_pair_row\", 6)",
      "}"
    ].join("\n");

    const compiled = compileSetFieldAttrRowMarkerTargets(source, form);
    assert.doesNotMatch(compiled, /\(MKXFORM\.setFieldAttr/);
    assert.match(
      compiled,
      /MKXFORM\.setFieldAttr\("fd_a", 4\); MKXFORM\.setFieldAttr\("fd_b", 4\)/
    );
    assert.match(
      compiled,
      /MKXFORM\.setFieldAttr\("fd_a", 6\); MKXFORM\.setFieldAttr\("fd_b", 6\)/
    );

    // Paren-comma expansion after a no-semicolon statement is parsed as a call.
    const broken = source.replace(
      'MKXFORM.setFieldAttr("fd_pair_row", 4)',
      '(MKXFORM.setFieldAttr("fd_a", 4), MKXFORM.setFieldAttr("fd_b", 4))'
    );
    assert.throws(() => {
      const fn = new Function("MKXFORM", `${broken}; return onLoad;`)({
        setValue() { return undefined; },
        setFieldAttr() { return undefined; }
      });
      fn();
    });

    const safeFn = new Function("MKXFORM", `${compiled}; return onLoad;`)({
      setValue() { return undefined; },
      setFieldAttr() { return undefined; }
    });
    assert.doesNotThrow(() => safeFn());
  });
});
