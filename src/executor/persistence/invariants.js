/** @typedef {"verified" | "mismatch" | "decode_failed" | "not_expected"} PartitionStatus */

export const INVARIANT_VERSION = 7;

export const EXECUTABLE_WORKFLOW_NODE_TYPES = Object.freeze([
  "generalStart",
  "draft",
  "review",
  "send",
  "robot",
  "startSubProcess",
  "conditionBranch",
  "split",
  "join",
  "generalEnd"
]);

export const EXECUTABLE_WORKFLOW_NODE_TYPE_SET = new Set(EXECUTABLE_WORKFLOW_NODE_TYPES);

/** Versioned allowlist of platform-owned system/default artifacts ignored by closed-world comparison. */
export const PLATFORM_OWNED = Object.freeze({
  version: 1,
  mainSystemFieldNames: Object.freeze([
    "fdId",
    "fdProcessId",
    "fdCreator",
    "fdCreateTime",
    "fdAlter",
    "fdAlterTime",
    "fdDeleted",
    "fdVersion",
    "fdSubject"
  ]),
  detailSystemFieldNames: Object.freeze([
    "fdId",
    "fdParentId",
    "fdMainId",
    "fdOrder"
  ]),
  ignoredFormAttrKeys: Object.freeze([
    "dataUnique",
    "currentTableName",
    "migrationDsl"
  ]),
  ignoredConfigKeys: Object.freeze([
    "authFilter",
    "lang",
    "extendMap",
    "sign",
    "error",
    "migrationDsl"
  ])
});

export const PARTITION_KEYS = Object.freeze([
  "envelope",
  "form",
  "rules",
  "scripts",
  "workflow"
]);
