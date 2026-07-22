import { NATIVE_FORM_RULE_FORMULA_CAPABILITY } from "../dsl/native-form-rule-capability.js";

const RUNTIME = NATIVE_FORM_RULE_FORMULA_CAPABILITY.modules.runtime;
const IDE = NATIVE_FORM_RULE_FORMULA_CAPABILITY.modules.ide;

export const NATIVE_FORM_RULE_FORMULA_RUNTIME_CAPABILITY = Object.freeze({
  id: NATIVE_FORM_RULE_FORMULA_CAPABILITY.id,
  catalogId: NATIVE_FORM_RULE_FORMULA_CAPABILITY.catalogId,
  catalogVersion: NATIVE_FORM_RULE_FORMULA_CAPABILITY.catalogVersion,
  runtimeModule: RUNTIME.digestKey,
  runtimePath: RUNTIME.path,
  runtimeHash: RUNTIME.release,
  runtimeSha256: RUNTIME.sha256,
  ideModule: IDE.digestKey,
  idePath: IDE.path,
  ideHash: IDE.release,
  ideSha256: IDE.sha256
});

export function inspectNativeFormRuleRuntimeDigest(digest) {
  const runtimeHash = digest?.[RUNTIME.digestKey]?.hash;
  const ideHash = digest?.[IDE.digestKey]?.hash;
  const issues = [];
  if (runtimeHash !== RUNTIME.release) {
    issues.push("xform_runtime_hash_unrecognized");
  }
  if (ideHash !== IDE.release) {
    issues.push("xform_ide_hash_unrecognized");
  }
  return {
    ok: issues.length === 0,
    capabilityId: NATIVE_FORM_RULE_FORMULA_CAPABILITY.id,
    catalogId: NATIVE_FORM_RULE_FORMULA_CAPABILITY.catalogId,
    catalogVersion: NATIVE_FORM_RULE_FORMULA_CAPABILITY.catalogVersion,
    runtimeHash,
    ideHash,
    issues
  };
}

export function inspectNativeFormRuleRuntimeBundleHashes({ runtimeSha256, ideSha256 } = {}) {
  const issues = [];
  if (runtimeSha256 !== RUNTIME.sha256) {
    issues.push("xform_runtime_bundle_sha256_unrecognized");
  }
  if (ideSha256 !== IDE.sha256) {
    issues.push("xform_ide_bundle_sha256_unrecognized");
  }
  return {
    ok: issues.length === 0,
    capabilityId: NATIVE_FORM_RULE_FORMULA_CAPABILITY.id,
    catalogId: NATIVE_FORM_RULE_FORMULA_CAPABILITY.catalogId,
    catalogVersion: NATIVE_FORM_RULE_FORMULA_CAPABILITY.catalogVersion,
    runtimeSha256,
    ideSha256,
    issues
  };
}
