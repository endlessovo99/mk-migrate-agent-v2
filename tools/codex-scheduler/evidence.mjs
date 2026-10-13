import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { digest, readJson, regularFile, requireValue } from "./common.mjs";

/** A process exit or an agent's prose is never a migration receipt. */
export function assessEvidence(task, dir, processResult) {
  const work = join(dir, "work");
  const files = readdirSync(work);
  const reports = files.filter((name) => /^execution-\d{3}\.report\.json$/.test(name)).sort();
  const intents = files.filter((name) => /^write-intent-\d{3}\.json$/.test(name)).sort();
  const evidence = [];
  let noRemoteWrites = true;
  try {
    requireValue(reports.length === intents.length, "An execution intent or receipt is missing");
    for (let index = 0; index < reports.length; index++) {
      const reportName = reports[index];
      const number = reportName.match(/\d{3}/)[0];
      const intentName = `write-intent-${number}.json`;
      requireValue(intents.includes(intentName), "Receipt has no matching intent");
      const intent = readJson(regularFile(join(work, intentName)));
      requireValue(intent.taskId === task.id && intent.baseUrl === task.baseUrl && intent.targetCategoryId === task.targetCategoryId &&
        intent.reportFile === reportName, "Execution intent differs from task scope");
      requireValue(typeof intent.dslFile === "string" && basename(intent.dslFile) === intent.dslFile && intent.dslFile.endsWith(".json"), "Invalid DSL evidence path");
      const dslBytes = readFileSync(regularFile(join(work, intent.dslFile)));
      requireValue(digest(dslBytes) === intent.dslSha256, "Executed DSL evidence changed");
      const dsl = JSON.parse(dslBytes);
      requireValue((dsl.workflow?.process?.templateId || dsl.derivedFrom?.sourceId) === task.sourceId, "DSL source identity differs");
      const path = regularFile(join(work, reportName));
      const report = readJson(path);
      evidence.push({ file: reportName, sha256: digest(readFileSync(path)) });
      requireValue(report.baseUrl === task.baseUrl && typeof report.remoteWriteAttempted === "boolean" && report.writeOutcomeUnknown === false,
        "Execution result is unknown or incompatible with this task");
      const touched = report.remoteWriteAttempted || report.templateId || report.createdFdIds?.length || report.updatedFdIds?.length;
      noRemoteWrites &&= report.remoteWriteAttempted === false && !report.templateId &&
        [report.createdFdIds, report.updatedFdIds].every((ids) => ids === undefined || (Array.isArray(ids) && ids.length === 0)) &&
        !report.transferRecord && !report.readback && !report.migrationStatus &&
        !["written", "written_with_warnings", "readback_failed", "transfer_record_failed"].includes(report.status) &&
        !report.writeOutcomeUnknownStage && report.ok === false &&
        (!report.apiStages || (Array.isArray(report.apiStages) && !report.apiStages.some((stage) =>
          ["add", "update", "saveWorkflowDraft", "addTransferRecord"].includes(stage?.name))));
      if (index < reports.length - 1) requireValue(!touched, "An earlier attempt already had remote effects");
      if (index === reports.length - 1) {
        if (report.ok === true && ["written", "written_with_warnings"].includes(report.status) && report.readback?.ok === true &&
            typeof report.templateId === "string" && report.templateId && report.transferRecord?.status === "recorded" &&
            report.transferRecord.fdOriginalId === task.sourceId && report.transferRecord.fdTargetId === report.templateId &&
            typeof report.transferRecord.fdId === "string" && report.transferRecord.fdId) {
          return { status: "succeeded", templateId: report.templateId, evidence,
            processWarning: processResult.code !== 0 || Boolean(processResult.signal) };
        }
        return { status: touched ? "needs_repair" : "needs_attention", evidence, reason: "execution_not_complete",
          noRemoteWriteConfirmed: noRemoteWrites };
      }
    }
    return { status: processResult.code === 0 ? "needs_attention" : "outcome_unknown", evidence, reason: "no_execution_receipt" };
  } catch {
    return { status: "outcome_unknown", evidence, reason: "missing_changed_or_uncertain_evidence" };
  }
}

export function readCompletion(dir) {
  const path = join(dir, "completion.json");
  return existsSync(path) ? readJson(regularFile(path)) : null;
}
