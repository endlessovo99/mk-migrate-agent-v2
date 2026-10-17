const WRITE_OPERATIONS = new Set(['add','addTemplate','update','updateTemplate','saveWorkflowDraft','addTransferRecord']);

/** A false summary never overrides an affirmative uncertainty elsewhere in a receipt. */
export function hasUnknownNativeWrite(report){
 if(!report||typeof report!=='object')return false;
 return ['writeOutcomeUnknown','templateWriteOutcomeUnknown','transferRecordOutcomeUnknown'].some(key=>report[key]!==undefined&&report[key]!==false)||
  ['outcome_unknown','unknown'].includes(report.status)||hasUnknownNativeWrite(report.transferRecord)||
  (report.apiStages||[]).some(stage=>hasUnknownNativeWrite(stage)||WRITE_OPERATIONS.has(stage.name)&&stage.status!=='ok');
}

export function hasUnconfirmedNativeIntent(steps){
 return (steps||[]).some(step=>WRITE_OPERATIONS.has(step.operation)&&step.outcome!=='confirmed');
}
