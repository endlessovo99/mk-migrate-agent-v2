# Source Format: SysFormTemplate XML

The v2 route-validation source format is `*_SysFormTemplate.xml`.

The file is a Java XMLDecoder export for `com.landray.kmss.sys.xform.base.model.SysFormTemplate`. The first adapter intentionally reads only the minimum fields needed for route validation:

- `fdId`
- `fdTemplateEdition`
- `fdModelName`
- `fdModelId`
- `fdDesignerHtml`
- `fdMetadataXml`

`fdMetadataXml` is currently the source of field definitions. `fdDesignerHtml` is currently used to infer the template title. A later adapter pass should use `fdDesignerHtml` for layout order, hidden/source-only fields, and rule references.

Bootstrap fixture:

```text
tests/fixtures/source/sysform-fixture-id_SysFormTemplate.xml
```

Do not add Landray/K2 compatibility while hardening this adapter.
