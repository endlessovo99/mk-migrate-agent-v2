import { applyFormPayload } from "./persistence/form-writer.js";
import { applyWorkflowPayload, buildWorkflowDraftPayload } from "./persistence/workflow-writer.js";
import { buildExpectedInvariants } from "./persistence/expected.js";
import { observeNativeTemplate } from "./persistence/observer.js";
import { compareInvariants } from "./persistence/compare.js";
import { buildFormSummary, buildWorkflowSummary } from "./persistence/summaries.js";
import { projectionError } from "./persistence/diagnostics.js";
import { INVARIANT_VERSION } from "./persistence/invariants.js";
import {verifiedTemplateReadBinding} from './template-read-scope.js';

export { buildWorkflowDraftPayload, INVARIANT_VERSION };

/**
 * Prepare a native template update and a bound deterministic verify capability.
 * Seam: after first getTemplate, before updateTemplate.
 */
export function preparePersistedTemplate({ dsl, envelope, baseTemplate }) {
  if (!dsl || typeof dsl !== "object") {
    return {
      ok: false,
      diagnostics: [projectionError("projection.dsl.invalid", "Persistence preparation requires a trusted DSL object.")]
    };
  }
  if (!envelope || typeof envelope !== "object") {
    return {
      ok: false,
      diagnostics: [projectionError("projection.envelope.invalid", "Persistence preparation requires an execution envelope.")]
    };
  }
  if (!baseTemplate || typeof baseTemplate !== "object") {
    return {
      ok: false,
      diagnostics: [projectionError("projection.base_template.invalid", "Persistence preparation requires the created template detail.")]
    };
  }

  let projectionDsl;
  try{projectionDsl=lowerTemplateAuthorizationForNativePersistence(dsl);}
  catch(error){return {ok:false,diagnostics:[projectionError(error.code||'projection.template.read_scope_invalid',error.message)]};}
  const expectedResult = buildExpectedInvariants(projectionDsl, envelope);
  if (!expectedResult.ok) {
    return {
      ok: false,
      diagnostics: expectedResult.diagnostics
    };
  }

  let update;
  try {
    const withCategory = {
      ...clone(baseTemplate),
      fdId: envelope.templateId || baseTemplate.fdId,
      fdCategory: { fdId: envelope.categoryId },
      fdName: envelope.templateName || baseTemplate.fdName,
      fdTableName: envelope.tableName || baseTemplate.fdTableName,
      fdStatus: envelope.lifecycle?.fdStatus ?? baseTemplate.fdStatus ?? 0
    };
    if (withCategory.mechanisms?.["sys-xform"]) {
      withCategory.mechanisms["sys-xform"] = {
        ...withCategory.mechanisms["sys-xform"],
        fdTableName: envelope.tableName || withCategory.mechanisms["sys-xform"].fdTableName,
        fdId: envelope.templateId || withCategory.mechanisms["sys-xform"].fdId
      };
    }
    update = applyWorkflowPayload(
      applyFormPayload(withCategory, projectionDsl),
      projectionDsl
    );
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        projectionError(
          error?.code || "projection.internal_error",
          error instanceof Error ? error.message : String(error),
          error?.details
        )
      ]
    };
  }

  const expected = expectedResult.expected;
  return {
    ok: true,
    update,
    verify(readbackTemplate) {
      return verifyPrepared(expected, readbackTemplate);
    }
  };
}

function lowerTemplateAuthorizationForNativePersistence(dsl) {
  const authorization = dsl?.template?.authorization;
  if (!authorization || typeof authorization !== "object") return dsl;
  if (![authorization.readers, authorization.editors, authorization.allReaders, authorization.allEditors]
    .every(Array.isArray)) return dsl;

  const editors = unionAuthorizationMembers(
    authorization.editors,
    authorization.allEditors
  );
  const editorIds = new Set(editors.map(authorizationMemberId).filter(Boolean));
  if(authorization.readScope){
    if(!verifiedTemplateReadBinding(dsl)||authorization.readers.length!==0||authorization.allReaders.length!==1||authorization.allReaders[0].id!==dsl.runtime.nativeTemplateReadScope.everyone.id)throw Object.assign(new Error('Public template readers require a verified native capability and exact builtin identity.'),{code:'projection.template.public_readers_unverified'});
    return {...dsl,template:{...dsl.template,authorization:{...authorization,readers:[],editors,allEditors:editors,allReaders:[authorization.allReaders[0]]}}};
  }
  let readers = unionAuthorizationMembers(
    authorization.readers,
    authorization.allReaders.filter((member) => !editorIds.has(authorizationMemberId(member)))
  );
  // A restricted reader remains a formal reader even after fallback coalesces it
  // with an editor. Empty formal readers would select native public mode.
  if(readers.length===0&&authorization.allReaders.length>0)readers=[...authorization.allReaders];
  if(readers.length===0)throw Object.assign(new Error('Empty native readers require source-bound public access evidence.'),{code:'projection.template.empty_read_scope_unproven'});
  return {
    ...dsl,
    template: {
      ...dsl.template,
      authorization: {
        ...authorization,
        readers,
        editors,
        // Native full-reading rights include the materialized formal editors.
        // This projection does not change source or temporary authorization.
        allEditors: editors,
        allReaders: unionAuthorizationMembers(readers, editors)
      }
    }
  };
}

function unionAuthorizationMembers(primary, additions) {
  const result = [...primary];
  const ids = new Set(result.map(authorizationMemberId).filter(Boolean));
  for (const member of additions) {
    const id = authorizationMemberId(member);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    result.push(member);
  }
  return result;
}

function authorizationMemberId(member) {
  return typeof member?.id === "string" ? member.id.trim() : "";
}

function verifyPrepared(expected, readbackTemplate) {
  const observed = observeNativeTemplate(readbackTemplate || {});
  const comparison = compareInvariants(expected, observed);
  const formSummary = observed.form.status === "decode_failed"
    ? emptyFormSummary()
    : buildFormSummary(observed.form.value, observed.rules.value, observed.scripts.value);
  const workflowSummary = expected.workflow?.expected
    ? (observed.workflow.status === "decode_failed" || observed.workflow.status === "not_expected"
      ? undefined
      : buildWorkflowSummary(observed.workflow.value))
    : undefined;

  return {
    ok: comparison.ok,
    status: comparison.status,
    invariantVersion: comparison.invariantVersion,
    partitions: comparison.partitions,
    form: formSummary,
    workflow: workflowSummary,
    diagnostics: comparison.diagnostics
  };
}

function emptyFormSummary() {
  return {
    fieldCount: 0,
    fields: [],
    detailTableCount: 0,
    subjectRule: undefined,
    persistence: { mainTableName: "", detailTables: [] },
    layoutRowCount: 0,
    layoutRootCount: 0,
    layoutNodeCount: 0,
    nestedLayoutCount: 0,
    layoutRows: [],
    scripts: { actionCount: 0, events: [], controlEvents: [], actions: [] },
    formRules: { displayRuleCount: 0, requireRuleCount: 0, displayRules: [], requireRules: [] }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
