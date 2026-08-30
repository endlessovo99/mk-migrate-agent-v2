export const REQUIRED_TEMPLATE_NUMBER_RULE_ID = "1k18j2ah9w1e1w6080w1phrhv41pemi72gw0";
export const REQUIRED_TEMPLATE_NUMBER_RULE_NAME = "流程管理编号规则";
export const TEMPLATE_NUMBER_RULE_CONTRACT_VERSION = 1;

const REQUIRED_TEMPLATE_NUMBER_RULE = Object.freeze({
  fdType: "1",
  fdSysNumber: Object.freeze({
    fdId: REQUIRED_TEMPLATE_NUMBER_RULE_ID,
    dynamicProps: Object.freeze({
      fdNameCn: REQUIRED_TEMPLATE_NUMBER_RULE_NAME
    }),
    fdEntityName: "com.landray.km.review.core.entity.KmReviewMain",
    fdDefaultFlag: true,
    fdName: REQUIRED_TEMPLATE_NUMBER_RULE_NAME
  }),
  passValidate: true,
  fdEntityKey: "kmReviewTemplate"
});

export function applyRequiredTemplateNumberRule(template) {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new TypeError("Template number-rule projection requires a template object.");
  }
  template.mechanisms = template.mechanisms || {};
  template.mechanisms.sysnumber = [clone(REQUIRED_TEMPLATE_NUMBER_RULE)];
  return template;
}

export function attachRequiredTemplateNumberRuleReadback(readback, template) {
  const verification = verifyRequiredTemplateNumberRule(template);
  const ok = readback.ok && verification.ok;
  return {
    ...readback,
    ok,
    status: ok ? readback.status : "readback_failed",
    numberRule: {
      contractVersion: TEMPLATE_NUMBER_RULE_CONTRACT_VERSION,
      status: verification.ok ? "verified" : "mismatch",
      ...verification.value
    },
    diagnostics: [...(readback.diagnostics || []), ...verification.diagnostics]
  };
}

function verifyRequiredTemplateNumberRule(template) {
  const entries = Array.isArray(template?.mechanisms?.sysnumber)
    ? template.mechanisms.sysnumber
    : [];
  const entry = entries[0] || {};
  const value = {
    fdId: String(entry.fdSysNumber?.fdId || ""),
    fdName: String(entry.fdSysNumber?.fdName || ""),
    fdType: String(entry.fdType || ""),
    fdEntityKey: String(entry.fdEntityKey || "")
  };
  const ok = entries.length === 1 &&
    value.fdId === REQUIRED_TEMPLATE_NUMBER_RULE_ID &&
    value.fdType === REQUIRED_TEMPLATE_NUMBER_RULE.fdType &&
    value.fdEntityKey === REQUIRED_TEMPLATE_NUMBER_RULE.fdEntityKey;

  return {
    ok,
    value,
    diagnostics: ok ? [] : [{
      level: "error",
      code: "readback.number_rule.mismatch",
      message: "Readback template does not use the required workflow-management number rule.",
      partition: "numberRule",
      path: "/mechanisms/sysnumber",
      details: {
        expected: {
          fdId: REQUIRED_TEMPLATE_NUMBER_RULE_ID,
          fdType: REQUIRED_TEMPLATE_NUMBER_RULE.fdType,
          fdEntityKey: REQUIRED_TEMPLATE_NUMBER_RULE.fdEntityKey
        },
        actual: value,
        entryCount: entries.length
      }
    }]
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
