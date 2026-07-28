import { DETAIL_TABLE_IDS, FIELD_IDS } from "./travel-reimbursement-lifecycle-contract.js";

export function buildCityModeOnChange() {
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    "  if (value == \"1\") {",
    `    MKXFORM.setValue(${json(FIELD_IDS.cityFlag)}, "1")`,
    "  } else {",
    `    MKXFORM.setValue(${json(FIELD_IDS.cityFlag)}, "0")`,
    `    MKXFORM.setDetailValues(${json(tableRef(DETAIL_TABLE_IDS.traffic))}, [{}])`,
    `    MKXFORM.setDetailValues(${json(tableRef(DETAIL_TABLE_IDS.train))}, [{}])`,
    `    MKXFORM.setDetailValues(${json(tableRef(DETAIL_TABLE_IDS.flight))}, [{}])`,
    "  }",
    "}"
  ].join("\n");
}

export function buildCostCenterOnChange(model) {
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    ...costCenterOptionLines(model, "value", "  "),
    "}"
  ].join("\n");
}

export function buildDepartmentOnChange(model) {
  return [
    "function onChange(value, rowNum, parentRowNum) {",
    ...departmentInitializationLines(model, "value", "  ", false),
    "}"
  ].join("\n");
}

export function buildLifecycleOnLoad(model) {
  return [
    "function onLoad() {",
    `  var rawCityMode = MKXFORM.getValue(${json(FIELD_IDS.cityMode)})`,
    "  var cityMode = Array.isArray(rawCityMode) ? rawCityMode[0] : rawCityMode",
    "  if (Number(cityMode) == 0) {",
    "    MKXFORM.setFieldAttr(\"fd_guonei_row\", 4)",
    "    MKXFORM.setFieldAttr(\"fd_guonei_row\", 6)",
    "  }",
    `  var department = MKXFORM.getValue(${json(FIELD_IDS.department)})`,
    `  var firstCostCenter = MKXFORM.getValue(${json(FIELD_IDS.firstCostCenter)})`,
    "  firstCostCenter = Array.isArray(firstCostCenter) ? firstCostCenter[0] : firstCostCenter",
    "  if (firstCostCenter == null || firstCostCenter === \"\") {",
    ...departmentInitializationLines(model, "department", "    ", true),
    "  }",
    "}"
  ].join("\n");
}

function departmentInitializationLines(model, expression, indent, alreadyGuarded) {
  const lines = [
    `${indent}var departmentParts = Array.isArray(${expression}) ? ${expression} : []`,
    `${indent}if (!departmentParts.length && ${expression} && typeof ${expression} === "object") {`,
    `${indent}  departmentParts = [${expression}.id || ${expression}.value || "", ${expression}.name || ${expression}.label || ${expression}.text || ""]`,
    `${indent}}`,
    `${indent}if (departmentParts.length > 1) {`,
    `${indent}  var departmentName = String(departmentParts[1] || "")`,
    `${indent}  var firstOptions = ${json(model.firstOptions)}`,
    `${indent}  var selectedFirst = ""`,
    `${indent}  for (var optionIndex = 0; optionIndex < firstOptions.length; optionIndex += 1) {`,
    `${indent}    if (departmentName.indexOf(firstOptions[optionIndex].label) >= 0) {`,
    `${indent}      selectedFirst = String(firstOptions[optionIndex].value)`,
    `${indent}      break`,
    `${indent}    }`,
    `${indent}  }`,
    `${indent}  if (selectedFirst) {`,
    `${indent}    var previousFirst = MKXFORM.getValue(${json(FIELD_IDS.firstCostCenter)})`,
    `${indent}    previousFirst = Array.isArray(previousFirst) ? previousFirst[0] : previousFirst`,
    `${indent}    if (String(previousFirst == null ? "" : previousFirst) !== selectedFirst) {`,
    `${indent}      MKXFORM.setValue(${json(FIELD_IDS.firstCostCenter)}, selectedFirst)`,
    ...costCenterOptionLines(model, "selectedFirst", `${indent}      `),
    `${indent}    }`,
    `${indent}  }`,
    `${indent}}`
  ];
  return alreadyGuarded ? lines : lines;
}

function costCenterOptionLines(model, expression, indent) {
  return [
    `${indent}var selectedFirstValue = Array.isArray(${expression}) ? ${expression}[0] : ${expression}`,
    `${indent}selectedFirstValue = String(selectedFirstValue == null ? "" : selectedFirstValue)`,
    `${indent}var optionGroups = ${json(model.optionGroups)}`,
    `${indent}var defaultOptions = ${json(model.secondOptions)}`,
    `${indent}var nextOptions = optionGroups[selectedFirstValue] || defaultOptions`,
    `${indent}MKXFORM.setProps(${json(FIELD_IDS.secondCostCenter)}, { options: nextOptions })`,
    `${indent}MKXFORM.setValue(${json(FIELD_IDS.secondCostCenter)}, "")`
  ];
}

export function buildSubmit(model) {
  return [
    "function onBeforeSubmit(context) {",
    "  if (context && context.isDraft) return true",
    `  var commonWBSStr = ${json(model.commonWbs)}`,
    `  var projectFlag = MKXFORM.getValue(${json(FIELD_IDS.projectFlag)})`,
    "  projectFlag = Array.isArray(projectFlag) ? projectFlag[0] : projectFlag",
    "  if (String(projectFlag) === \"1\") {",
    `    var projectValue = MKXFORM.getValue(${json(tableRef(DETAIL_TABLE_IDS.project))})`,
    "    var projectRows = Array.isArray(projectValue) ? projectValue : ((projectValue && projectValue.values) || [])",
    "    var invalidWbsRows = []",
    "    for (var projectIndex = 0; projectIndex < projectRows.length; projectIndex += 1) {",
    "      var wbsValue = String(projectRows[projectIndex].fd_bseg_projk || \"\")",
    "      if (commonWBSStr.indexOf(wbsValue) < 0) invalidWbsRows.push(projectIndex + 1)",
    "    }",
    "    if (invalidWbsRows.length) {",
    "      MKXFORM.toast(\"第\" + invalidWbsRows.join(\"、\") + \"行的项目/令号不存在，请重新填写。\")",
    "      return false",
    "    }",
    "  }",
    `  var payeeValue = MKXFORM.getValue(${json(tableRef(DETAIL_TABLE_IDS.payee))})`,
    "  var payeeRows = Array.isArray(payeeValue) ? payeeValue : ((payeeValue && payeeValue.values) || [])",
    "  var invalidCardRows = []",
    "  for (var payeeIndex = 0; payeeIndex < payeeRows.length; payeeIndex += 1) {",
    "    if (String(payeeRows[payeeIndex].fd_card_number || \"\").length < 16) invalidCardRows.push(payeeIndex + 1)",
    "  }",
    "  if (invalidCardRows.length) {",
    "    MKXFORM.toast(\"收款人明细表中：第\" + invalidCardRows.join(\"、\") + \"行的卡号位数不满足16-19位，请重新检查。\")",
    "    return false",
    "  }",
    "  var payeeTotal = 0",
    "  for (var amountIndex = 0; amountIndex < payeeRows.length; amountIndex += 1) {",
    "    var payeeAmount = Number(payeeRows[amountIndex].fd_payee_amount || 0)",
    "    payeeTotal = Math.round((payeeTotal + payeeAmount) * 100) / 100",
    "  }",
    `  MKXFORM.setValue(${json(FIELD_IDS.payeeTotal)}, payeeTotal)`,
    `  var totalCost = MKXFORM.getValue(${json(FIELD_IDS.totalCost)})`,
    "  totalCost = Array.isArray(totalCost) ? totalCost[0] : totalCost",
    "  var payeeDifference = payeeTotal - Number(totalCost || 0)",
    `  MKXFORM.setValue(${json(FIELD_IDS.payeeDifference)}, payeeDifference)`,
    "  if (payeeDifference != 0) {",
    "    MKXFORM.toast(\"收款金额与费用总计差额不为0，请核对！\")",
    "    return false",
    "  }",
    `  MKXFORM.setValue(${json(FIELD_IDS.saveFlag)}, 2222)`,
    "  return true",
    "}"
  ].join("\n");
}

function tableRef(tableId) {
  return `\${table:${tableId}}`;
}

function json(value) {
  return JSON.stringify(value);
}
