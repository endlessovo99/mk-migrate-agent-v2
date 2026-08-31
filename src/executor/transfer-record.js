import { randomBytes } from "node:crypto";

export const TRANSFER_RECORD_ENDPOINT_PATH = "/data/sys-transfer/transferRecord/add";
export const TRANSFER_RECORD_ENDPOINT_URL =
  `http://oadev.shanghai-electric.com${TRANSFER_RECORD_ENDPOINT_PATH}`;

export const TRANSFER_RECORD_FIXED_FIELDS = Object.freeze({
  fdModuleName: "流程管理",
  fdModuleId: "frameworkMeta#km-review",
  fdEntityId: "frameworkMeta#com.landray.km.review.core.entity.KmReviewTemplate",
  fdEntityLabel: "流程模板",
  fdTransferTaskId: "1j7jf65kew1ef0w9akw327oqf633vupsq3w0",
  fdTransferTaskName: "模板",
  fdTaskMainId: "1j7jf65krw1ef0w9avwl0d3k13si83i7rtw0"
});

export function buildTransferRecordPreflight(input, options = {}) {
  const fdId = requiredString(options.fdId, "transfer record fdId");
  const fdOriginalId = originalTemplateId(input);
  const fdName = requiredString(input?.template?.name, "source template name");
  const fdCreateTime = timestamp(options.now);

  return {
    fdId,
    ...TRANSFER_RECORD_FIXED_FIELDS,
    fdOriginalId,
    fdName,
    fdCreateTime
  };
}

export function buildTransferRecordPayload(input, options = {}) {
  return {
    ...buildTransferRecordPreflight(input, options),
    fdTargetId: requiredString(options.targetTemplateId, "target template fdId")
  };
}

export function generateTransferRecordId() {
  let id = "";
  while (id.length < 36) {
    id += randomBytes(36)
      .toString("base64url")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }
  return id.slice(0, 36);
}

function originalTemplateId(input) {
  const workflowTemplateId = String(input?.workflow?.process?.templateId || "").trim();
  if (workflowTemplateId) return workflowTemplateId;
  return requiredString(input?.derivedFrom?.sourceId, "source template fdId");
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function timestamp(value) {
  const time = new Date(value ?? Date.now()).getTime();
  if (!Number.isFinite(time)) throw new TypeError("transfer record timestamp is invalid");
  return time;
}
