# Issue #18: MK Control Event/Action Catalog Handoff

## Goal

Build a versioned target-side catalog for MK control script event/action support.

The catalog must tell v2, per target MK component, which designer events and action/API families are supported for script migration. The output is consumed by DSL validation, dry-run/check reporting, and later Agent Review/script repair.

This is a narrow route-validation task. Preserve DSL as the public boundary between translation and execution.

## Boundary

- No NewOA writes for this task.
- No browser automation in the v2 executor path.
- Hermes Agent may perform SIT read-only browser inspection or export only.
- Do not save, publish, create, modify, or delete NewOA templates during evidence collection.
- Default tests must stay offline and use fake/local fixtures only.
- Do not add frontend, batch mode, source formats outside the current XML route-validation scope, PI/Agent execution, or production writes.

## Current Execution Plan

Hermes Agent is no longer on the critical path for evidence collection. Codex will directly operate the browser and produce the evidence table.

The current browser state:

- Target URL: `https://p-sit.onewo.com/`
- Current designer URL: `https://p-sit.onewo.com/web/#/manage/km-review/kmReviewTemplate/edit/1jt2nnqicw57ew6u3lw3kvk33k99v1cd2qw0/designer`
- Visible page title: `模板编辑(万物云空间科技服务股份有限公司)`
- Template name observed in DOM: `模版控件事件测试-王茂`
- Available browser surface: Codex in-app browser only

The user has completed manual login in the in-app browser. Codex can inspect the designer read-only from the current tab.

## Browser Strategy From `../mk-migrate-agent`

The sibling v1 repo uses a better browser strategy than hard-clicking designer canvas controls:

- `src/browser/newoa-api.js` defines `postNewoaApi(page, apiPath, payload)`, which calls `/data/km-review/<apiPath>` from the logged-in page context.
- `src/browser/plan-executor.js` loads template detail through `kmReviewTemplate/get` with `{ fdId, mechanisms: { load: "*" } }`.
- `src/browser/designer-script-panel.js` prefers stable designer action-route selectors such as `[data-tid="xf-icc-property-actionGroup-globalAction"]` over coordinate clicks.

Apply the idea, not the implementation:

- For evidence collection, prefer read-only API/config extraction over canvas clicking.
- Do not port v1 browser modules into v2.
- Do not use browser automation in the v2 executor path.
- Treat any v1 update/save path as out of scope for issue #18 unless the user gives explicit write confirmation for a separate executor task.

Current in-app browser limitation:

- `tab.playwright.evaluate(...)` can read DOM (`document`, `location`) but its read-only sandbox does not expose `fetch`, `XMLHttpRequest`, or normal `window` application globals.
- Therefore v1's `postNewoaApi` cannot be executed verbatim in the current in-app browser control surface.
- Continue evidence gathering through DOM inspection, page assets/bundles, read-only export if available, or a browser surface that permits same-origin API calls.

Chrome DevTools path:

- A Chrome remote-debugging instance is available at `127.0.0.1:9222`.
- The target tab is the same designer page:
  `https://p-sit.onewo.com/web/#/manage/km-review/kmReviewTemplate/edit/1jt2nnqicw57ew6u3lw3kvk33k99v1cd2qw0/designer`
- CDP `Runtime.evaluate` runs in the real page context and can call same-origin `fetch`.
- This successfully called:

```text
POST /data/km-review/kmReviewTemplate/get
payload: { fdId: "1jt2nnqicw57ew6u3lw3kvk33k99v1cd2qw0", mechanisms: { load: "*" } }
```

Observed response:

- HTTP status: `200`
- `success: true`
- message: `您的操作已成功！`
- template name: `模版控件事件测试-王茂`
- mechanism keys: `load`, `sys-xform`, `ai-form`, `sys-auth`, `lbpmTemplate`, `sysnumber`

Parsed config locations:

- `mechanisms["sys-xform"].fdConfig` is a JSON string.
- `fdConfig.dataModel[0].fdFields[*].fdAttribute` contains field/control attributes as JSON strings.
- `fdConfig.viewModel[0].fdConfig` contains the render tree as a JSON string.

Current template field evidence:

- `单行文本1`: `fdType=text`, `elemKey=@elem/xform-input~gm2a18`
- `主题`: `fdType=subject`, `elemKey=@elem/xform-subject~aacwuq`
- `多行文本1`: `fdType=textarea`, `elemKey=@elem/xform-textarea~a5ocml`
- `单选框1`: `fdType=radio`, `elemKey=@elem/xform-radio~29z5ld`
- `多选框1`: `fdType=checkbox`, `elemKey=@elem/xform-checkbox~ixchqk`
- `单选下拉框1`: `fdType=select`, `elemKey=@elem/xform-select~82eerq`
- `多选下拉框1`: `fdType=select~multi`, `elemKey=@elem/xform-select~multi~mpmurl`
- `日期1`: `fdType=timestamp`, `elemKey=@elem/xform-datetime~hcudtm`
- `数值1`: `fdType=numbertext`, `elemKey=@elem/xform-number~gogqv9`
- `时间1`: `fdType=timepicker`, `elemKey=@elem/xform-timepicker~qj44o8`
- `金额1`: `fdType=moneytext`, `elemKey=@elem/xform-money~dwlo4j`
- `附件1`: `fdType=attachment`, `elemKey=@elem/xform-attach~nr483v`
- `地址本1`: `fdType=address`, `elemKey=@elem/xform-address~8764w3`

The current template's parsed field attributes do not contain configured control action/event keys. Use designer UI/options or bundle/runtime evidence to infer available event support; use exported/config readback only for configured actions.

## Headed Chrome Designer Evidence

Collection method:

- Used the headed Chrome tab attached through CDP at `127.0.0.1:9222`.
- Brought Chrome to the foreground so browser steps were visible.
- Per control:
  - performed a real CDP mouse click on the canvas field center,
  - verified the selected canvas key,
  - scrolled the right property panel to `动作设置`,
  - clicked `添加动作`,
  - read the designer event option lists from the real page DOM.
- No event was selected and no `确定`, save, publish, create, delete, or submit action was clicked.

Important DOM detail:

- The designer keeps a hidden form-global event list in the DOM:
  `onLoad加载完毕`, `onBeforeSubmit提交前事件`, `onAfterSubmit提交后事件`.
- For control evidence, use the non-global `custom-select-cmpt-render-body` list associated with the selected control's `添加动作`.
- The page label currently spells delete as `onDelect删除事件`; preserve this as observed evidence and map deliberately if the runtime/API uses another spelling.

Observed control event options:

```text
componentId          label           selectedKey                         control events
xform-input          单行文本1        @elem/xform-input~gm2a18             onChange, onFocus, onBlur
xform-textarea       多行文本1        @elem/xform-textarea~a5ocml          onChange, onFocus, onBlur
xform-radio          单选框1          @elem/xform-radio~29z5ld             onChange
xform-checkbox       多选框1          @elem/xform-checkbox~ixchqk          onChange
xform-select         单选下拉框1      @elem/xform-select~82eerq            onChange, onSelect, onDelect
xform-select~multi   多选下拉框1      @elem/xform-select~multi~mpmurl      onChange, onSelect, onDelect
xform-datetime       日期1            @elem/xform-datetime~hcudtm          onChange
xform-number         数值1            @elem/xform-number~gogqv9            onChange
xform-timepicker     时间1            @elem/xform-timepicker~qj44o8        onChange
xform-money          金额1            @elem/xform-money~dwlo4j             onChange
xform-attach         附件1            @elem/xform-attach~nr483v            onChange
xform-address        地址本1          @elem/xform-address~8764w3           onChange
```

Evidence confidence:

- `supported` for the listed normal-field control events, based on headed designer options.
- Detail-column behavior is not proven by this template unless a detail-table test field is added or an existing detail fixture is inspected.
- `xform-description`, `xform-detail-table`, and layout components were not present as actionable control fields in this template; keep them `unsupported` or `unknown` according to catalog semantics, not inferred from field controls.

Additional v1 gap controls added by the user and rechecked after page reload:

- `mechanisms["sys-xform"].fdConfig` field count increased to `51`.
- New persisted fields observed:
  - `富文本1`: `fdType=rich-text`, `elemKey=@elem/xform-rich-text~xpvutc`
  - `链接1`: `fdType=hyperlinks`, `elemKey=@elem/xform-hyperlinks~ykq6n3`
  - `分割线`: `fdType=dividing`, `elemKey=@elem/xform-divider~y7dxrl`

Observed additional control event options:

```text
componentId        label      selectedKey                         control events
xform-subject      主题       @elem/xform-subject~aacwuq           none; no control action section
xform-timepicker   时间1      @elem/xform-timepicker~qj44o8        onChange, onOk
xform-rich-text    富文本1    @elem/xform-rich-text~xpvutc         onChange
xform-hyperlinks   链接1      @elem/xform-hyperlinks~ykq6n3        onChange
xform-divider      分割线     @elem/xform-divider~y7dxrl           none; no control action section
```

Notes:

- `xform-timepicker` had previously been recorded as `onChange` only from the first pass. After adding the v1-gap controls and rechecking the dedicated time control panel, the designer showed `onChange值发生变化` and `onOk点击确定按钮`.
- `xform-divider` showed a control panel with field/name/style settings but no `动作设置`; treat control events as unsupported/not applicable for normal field scope.
- `xform-subject` showed a subject-specific panel with no `动作设置`; treat control events as unsupported/not applicable for normal field scope.

Observed page asset entry points:

- `https://p-sit.onewo.com/web/km-review/manage/pages/kmReviewTemplate/edit/index.js?66e4304b16ab093770422c4dd631e6eb`
- `https://p-sit.onewo.com/web/sys-xform/desktop/api/commonUtil/index.js?7a0a68c49911191587b9f37361433b2c`
- The current page asset inventory includes 73 script resources.

Already downloaded bundle evidence under `/tmp`:

- `/tmp/xform-bundle-desktop.js`
- `/tmp/XFormIDEFragment.js`
- `/tmp/kmReviewTemplateEdit.js`

Useful bundle evidence query:

```bash
rg -n -o 'actionFunsRunner\([^)]{0,180}\)' /tmp/xform-bundle-desktop.js
```

Observed runtime event strings in bundle evidence include `onChange`, `onFocus`, `onBlur`, `onOk`, `onSuccess`, and `onError`. These are runtime evidence only; do not mark every component as supported until mapped to component families or confirmed in designer/export evidence.

## Task Split

Design owner:

- Own final product and catalog semantics.
- Decide which component events are `supported`, `unsupported`, or `unknown`.
- Decide whether evidence is sufficient for execute-time support.

Codex:

- Directly operate the browser for SIT read-only evidence collection.
- Produce the component evidence table in this document's schema.
- Turn the design and evidence into an implementation plan and code changes.
- Wire the catalog into DSL validation and dry-run/check reporting.
- Add fixture-driven tests and keep `npm test` offline.

Hermes Agent:

- Removed from critical path due to poor execution quality.
- May be used only as a secondary observer if explicitly requested later.

## Browser Evidence Protocol

Codex must produce evidence rows with this schema:

```text
componentId | label | scope | event | status | detailColumn | handlerSignature | actionFamilies | evidenceSource | notes
```

Allowed `status` values:

- `supported`: evidence confirms this component/scope supports the event or action family.
- `unsupported`: evidence confirms this component/scope does not support it.
- `unknown`: evidence is missing, incomplete, contradictory, or not auditable.

Allowed `scope` values:

- `field`
- `detailColumn`
- `detailTable`
- `layout`
- `global`

Evidence source examples:

- MK docs
- SIT read-only designer inspection
- SIT read-only export
- existing route-validation fixture evidence
- readback/export evidence

Notes should include limits or uncertainty, for example:

- `normal field supported; detail column not visible in designer`
- `handler signature observed as value only`
- `component has no script event panel`
- `export did not include control action metadata`

## Components To Cover

Cover every component currently listed in `catalogs/mk-components.v1.json`:

- `xform-input`
- `xform-textarea`
- `xform-radio`
- `xform-checkbox`
- `xform-select`
- `xform-select~multi`
- `xform-datetime`
- `xform-number`
- `xform-address`
- `xform-attach`
- `xform-description`
- `xform-detail-table`
- `xform-flex-1-1-layout`
- `xform-flex-1-2-layout`
- `xform-flex-1-3-layout`
- `xform-flex-1-4-layout`
- `xform-multi-row-table-layout`

Layout components should be explicitly represented as unsupported or not applicable for control script events. Do not leave them out.

## Catalog Expectations

Add a versioned catalog, expected path:

```text
catalogs/mk-control-events.v1.json
```

The catalog should include, per component and scope:

- component id and label
- supported or unsupported events
- event labels
- scope
- handler signature and parameter names
- whether the event is supported in detail-table columns
- supported target action/API families where known
- evidence/status metadata
- notes sufficient for audit

Do not silently assume every field-like control supports `onChange`.

## Validation Expectations

Current code treats control events broadly through `SCRIPT_CONTROL_EVENTS = new Set(["onChange"])`. Replace that behavior with catalog-backed compatibility checks.

Required behavior:

- `check draft` may warn when catalog evidence is unknown or incomplete.
- `check execute` must fail when an executable script action uses an event/action unsupported by the target component catalog.
- Detail-table columns must be validated through `tableId + controlId` and the `detailColumn` catalog scope.
- Normal fields must be validated through `controlId` and the `field` catalog scope.
- Description, layout, and detail-table container components must not be implicitly treated as normal field controls.

Suggested diagnostic intent:

- unknown or incomplete catalog evidence: warning in draft/check reporting
- unsupported component event in execute: error
- scope mismatch, such as using a detail-column-only event on a normal field: error in execute
- unresolved control target behavior remains unchanged

## Dry-Run And Check Reporting

Dry-run/check reporting should summarize script actions by event and catalog support status.

At minimum, report:

- action count
- event names
- support status counts, such as `supported`, `unsupported`, and `unknown`
- component ids involved
- detail-column actions separately when useful

Invalid execute input should keep the script step blocked.

## Test Expectations

Add fixture-driven tests for:

- text: `xform-input`
- textarea: `xform-textarea`
- select: `xform-select` and `xform-select~multi`
- radio: `xform-radio`
- checkbox: `xform-checkbox`
- date/time: `xform-datetime`
- number: `xform-number`
- organization/address: `xform-address`
- attachment: `xform-attach`
- description: `xform-description`
- detail-table column behavior

Specific scenarios:

- supported component/event passes execute validation
- unsupported component/event fails execute validation
- unknown/incomplete evidence produces a draft warning
- detail column without `tableId` still fails as unresolved detail target
- detail column with `tableId` uses detail-column catalog support
- dry-run summarizes catalog support status for script actions
- existing offline `npm test` remains passing

## Browser Safety Rules

- Browser work is read-only unless the user explicitly authorizes a write action.
- Do not click save, publish, create, delete, submit, or any action that mutates NewOA/MK data.
- If a login, OTP, CAPTCHA, or sensitive credential entry is required, stop and ask the user to complete it in the browser.
- If an export/download is available and read-only, it may be used to collect evidence.
- If an operation's side effect is unclear, treat it as mutating and do not perform it.

## Assumptions

- The user can complete SIT SSO login in the in-app browser when prompted.
- If SIT access is unavailable, evidence rows should use `unknown`.
- Action/API family support starts from the current `MKXFORM.*` allowlist. Do not expand callable target APIs without auditable evidence and design-owner confirmation.
- This task does not authorize NewOA writes.
