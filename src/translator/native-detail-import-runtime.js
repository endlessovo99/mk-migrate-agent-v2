import { nativeLocalFormulaRows, nativeDeclaredMainSums, nativeImportCalculationPreview, nativeCurrencyComputationSources } from "./native-import-calculations.js";

/** Exact public projection of the native detail import formData profile. */
export function nativeImportFormData(MKXFORM, systemFieldNames) {
  if (!Array.isArray(systemFieldNames) || systemFieldNames.indexOf("mechanisms") >= 0) throw new Error("Native system fields shadow the reserved mechanism context.");
  var values = MKXFORM.getFormValues(), config = MKXFORM.getFormConfigs();
  if (!values || typeof values !== "object" || !values._dynamicProps || typeof values._dynamicProps !== "object" || !config || !Array.isArray(config.forms)) throw new Error("Native form context is unavailable.");
  var mechanisms = values._dynamicProps.mechanisms, xform = mechanisms && mechanisms["sys-xform"], base = xform && xform.dynamicProps;
  if (base !== undefined && base !== null && (typeof base !== "object" || Array.isArray(base))) throw new Error("Native ambient dynamicProps must be an object.");
  var data = Object.assign({}, base), seen = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.childrenGroup || node.tempConfig || node.options && node.options.tempConfig) throw new Error("Grouped or temporary native form context is unsupported.");
    if (node.kind === "control") {
      var p = node.controlProps;
      if (!p || typeof p !== "object" || typeof node.key !== "string" || seen.indexOf(node.key) >= 0) throw new Error("Native control identity is ambiguous.");
      seen.push(node.key);
      switch (p.$$tableType) {
        case "main": data[p.name] = p.value; break;
        case "single": data[p.$$tableName + "." + p.name] = p.value; break;
        case "detail": data[p.$$tableName] = p.value && p.value.values; break;
      }
    }
    if (Array.isArray(node.items)) node.items.forEach(visit);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  }
  config.forms.forEach(visit);
  return data;
}

export const NATIVE_DETAIL_IMPORT_CALCULATION_PROFILE = "native-detail-import-native-calculations-v1";
export const NATIVE_IMPORT_CALCULATION_POLICY_PROFILE = "native-row-local-eval-main-sum-currency-v1";

export const NATIVE_DETAIL_IMPORT_PROFILE = "native-detail-import-confirmed-replace-v1";

/** Fixed script generator; source/policy admission belongs to the caller. */
export function nativeDetailImportFunction(input, entry = "import") {
  if (!["import", "download"].includes(entry)) throw new Error("Unknown native import entrance.");
  const spec = { ...input, tableId: "${table:" + input.tableId + "}", xformId: "${xform:id}", entry };
  const calculation = input.calculationPlan;
  if (calculation) spec.calculationPlan = { ...calculation, tableId: spec.tableId, mainSums: calculation.mainSums.map(sum => ({ ...sum, tableId: spec.tableId })) };
  const currencyComputations = calculation ? nativeCurrencyComputationSources(calculation) : [];
  return `function onClick() {
  var spec = ${JSON.stringify(spec)};
  var React = window.react, UI = window["@lui/core"], base = window["@elem/xform-base"];
  if (!base || !base.innerHttp || typeof base.innerHttp.post !== "function") {
    try {
      var loader = window["@ekp-infra/requirejs"];
      base = loader && typeof loader.getModule === "function" ? loader.getModule("@elem/xform-base") : null;
    } catch (error) { base = null; }
  }
  if (!React || !UI || !UI.Upload || !UI.Button || !UI.Table || !base || !base.innerHttp || typeof base.innerHttp.post !== "function" || !MKXFORM.tableModal) {
    MKXFORM.message.error("导入组件暂不可用，请刷新页面后重试；原明细保持不变。");
    return;
  }
  var http = base.innerHttp, api = spec.targetOrigin + "/data";
  var closed = false, ready = false, sequence = 0, timer = null, rows = [], message = "请使用目标系统生成的新模板；不执行旧位置格式转换。";
  var modal;${calculation ? "\n  var mainValues = {}, currencyValues = {};" : ""}
  ${nativeImportFormData.toString()}${calculation ? "\n  " + nativeLocalFormulaRows.toString() + "\n  " + nativeDeclaredMainSums.toString() + "\n  " + nativeImportCalculationPreview.toString() + "\n  var currencyComputations = [" + currencyComputations.join(",\n") + "];" : ""}
  function formData() { return nativeImportFormData(MKXFORM, spec.systemFieldNames); }
  function refresh() { if (!closed && modal) modal.update({ content: content(), okButtonProps: { disabled: !ready } }); }
  function fail() { if (closed) return; ready = false; rows = []; message = "上传、解析或校验失败；原明细保持不变。"; refresh(); }
  function cancel() { closed = true; sequence += 1; if (timer !== null) clearTimeout(timer); }
  function download() {
    if (closed) return;
    var data;
    try { data = formData(); } catch (error) { fail(); return; }
    var names = spec.fields.map(function(field) { return field.id; });
    http.post(api + "/sys-xform/sysXFormDataTransport/exportDetailTemplate", { tableName: spec.tableId, xformId: spec.xformId,
      personMatchType: "", deptMatchType: "", sortedFieldList: names, transportFields: names, fieldColumnWidthMap: {},
      requiredFields: spec.fields.filter(function(field) { return field.required; }).map(function(field) { return field.id; }), formData: data },
      { headers: { "Content-Type": "application/json" }, responseType: "blob" }).then(function(response) {
        if (closed || !response || !response.data) return;
        var blob = new Blob([response.data], { type: "application/vnd.ms-excel" });
        var url = window.URL.createObjectURL(blob), anchor = document.createElement("a");
        anchor.style.display = "none"; anchor.href = url; anchor.download = "MK_TEST_" + spec.tableId + ".xlsx";
        document.body.appendChild(anchor); anchor.click(); window.URL.revokeObjectURL(url); document.body.removeChild(anchor);
      }).catch(fail);
  }
  function acceptedRows(parsed) {
    if (!Array.isArray(parsed)) return null;
    var result = [];
    for (var i = 0; i < parsed.length; i += 1) {
      var row = parsed[i];
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      if (JSON.stringify(row) === "{}") continue;
      var names = Object.keys(row);
      for (var j = 0; j < names.length; j += 1) if (spec.allFieldIds.indexOf(names[j]) < 0 && ["key", "fd_id", "fd_main_id", "fd_order", "fd_parent_id"].indexOf(names[j]) < 0) return null;
      var projected = {};
      for (var f = 0; f < spec.fields.length; f += 1) {
        var field = spec.fields[f], value = row[field.id];
        if (field.required && (value === null || value === undefined || value === "")) return null;
        if (value !== null && value !== undefined && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
        if (typeof value === "number" && !Number.isFinite(value)) return null;
        if (value !== undefined) projected[field.id] = value;
      }
      result.push(projected);
    }
    return result;
  }
  function poll(id, ticket, count) {
    if (closed || ticket !== sequence) return;
    if (count >= spec.maxPolls) { fail(); return; }
    http.post(api + "/sys-xform/sysXFormDataTransport/process", { fdId: id }, { headers: { "Content-Type": "application/json" } }).then(function(response) {
      if (closed || ticket !== sequence) return;
      var body = response && response.data, job = body && body.data;
      if (!body || body.success === false || !job) { fail(); return; }
      if (job.percent === 1) {
        if (job.success === false) { fail(); return; }
        var accepted = acceptedRows(job.data);
        if (accepted === null) { fail(); return; }
        ${calculation ? `nativeImportCalculationPreview(spec.calculationPlan, accepted, MKXFORM, base, function() { return !closed && ticket === sequence; }, currencyComputations).then(function(preview) {
          if (closed || ticket !== sequence) return;
          rows = preview.rows; mainValues = preview.mainValues; currencyValues = preview.currencyValues; ready = true;
          message = "解析和原生计算完成，共 " + rows.length + " 条。确认后覆盖全部原明细及其声明的计算结果；0条将清空明细。"; refresh();
        }).catch(function() { if (!closed && ticket === sequence) fail(); }); return;` : `rows = accepted; ready = true; message = "解析完成，共 " + rows.length + " 条。确认后将覆盖全部原明细；0条将清空明细。"; refresh(); return;`}
      }
      timer = setTimeout(function() { poll(id, ticket, count + 1); }, 200);
    }).catch(function() { if (!closed && ticket === sequence) fail(); });
  }
  function upload(options) {
    if (closed) return;
    var ticket = ++sequence, data;
    ready = false; rows = []; message = "正在上传和解析；原明细保持不变。"; refresh();
    try { data = formData(); } catch (error) { fail(); options.onError(error); return; }
    var multipart = new FormData(); multipart.append("fdFile", options.file);
    http.post(api + "/sys-attach/upload", multipart).then(function(response) {
      if (closed || ticket !== sequence) return;
      var body = response && response.data, attach = body && body.data && body.data.fdAttachFileId;
      if (!body || body.success === false || typeof attach !== "string" || !attach) { fail(); return; }
      options.onSuccess(body);
      return http.post(api + "/sys-xform/sysXFormDataTransport/asyncImportDetailData", { xformId: spec.xformId, tableName: spec.tableId, attachId: attach, formData: data },
        { headers: { "Content-Type": "application/json" } }).then(function(result) {
          if (closed || ticket !== sequence) return;
          var envelope = result && result.data, id = envelope && envelope.data && envelope.data.id;
          if (!envelope || envelope.success === false || typeof id !== "string" || !id) { fail(); return; }
          poll(id, ticket, 0);
        });
    }).catch(function(error) { if (!closed && ticket === sequence) { fail(); options.onError(error); } });
  }
  function content() {
    return React.createElement("div", null,
      React.createElement(UI.Button, { onClick: download }, "下载新模板"),
      React.createElement(UI.Upload, { name: "fdFile", accept: ".xlsx,.xls", action: api + "/sys-attach/upload", customRequest: upload, itemRender: function() { return null; } },
        React.createElement(UI.Button, null, "选择Excel文件")),
      React.createElement("p", null, message),
      React.createElement(UI.Table, { dataSource: rows, rowKey: function(row, index) { return String(index); }, pagination: { pageSize: 10 },
        columns: spec.fields.map(function(field) { return { title: field.title, dataIndex: field.id, key: field.id }; }) }));
  }
  function commit() {
    if (closed || !ready) return true;
    try { formData(); } catch (error) { fail(); return true; }
    MKXFORM.setDetailValues(spec.tableId, rows);${calculation ? `
    spec.calculationPlan.mainSums.forEach(function(sum) { MKXFORM.setValue(sum.id, mainValues[sum.id]); });
    spec.calculationPlan.currencyEffects.forEach(function(effect) { MKXFORM.setValue(effect.targetId, currencyValues[effect.targetId]); });` : ""}
    cancel();
  }
  if (spec.entry === "download") { download(); return; }
  try { formData(); } catch (error) { return; }
  modal = MKXFORM.tableModal({ table: {}, modal: { title: "Excel覆盖导入", content: content(), okText: "确认覆盖", cancelText: "取消", okCancel: true,
    okButtonProps: { disabled: true }, onOk: commit, onCancel: cancel } });
}`;
}
