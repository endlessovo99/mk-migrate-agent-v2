# Ordered row-marker proof

The main fixture has one String singleSelect and one persisted row marker. The source reads the vendor getter's first result inside an unchanged 510 ms callback. The reviewed target reads the scalar MKXFORM value at the same position. This uses the project's registered getter recipe and typed source/target evidence; it is not an observation of the source vendor runtime.

The synchronous fixture isolates complete atomic effect closure. The function named `existing-atomic-boolean-alias-ternary` intentionally omits the source prelude and is a negative. Tests also cover a preserved-prelude ternary and a matching source with no prelude.

`designer-only-getter_SysFormTemplate.xml` removes only the select's metadata record. It retains explicit Designer String type, singleSelect identity and static string options. Partial, null or conflicting metadata is not equivalent to missing metadata.

Both registered fake routes require ordinary draft, patch, trust, execute-check, dry-run, persistence/readback and transfer-record gates. Tests make no real model or target requests. The token checker does not infer arbitrary JavaScript, scheduler aliases, date logic or vendor runtime implementations.
