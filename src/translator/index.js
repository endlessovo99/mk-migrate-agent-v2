import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { translateLbpmProcessDefinitionXml } from "./lbpm-process-definition-adapter.js";
import { translateSysFormTemplateXml } from "./sysform-template-adapter.js";

export function translateSourceFile(path, options = {}) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return translateSourceDirectory(path, options);
  }

  if (!/_SysFormTemplate\.xml$/i.test(path)) {
    if (/_LbpmProcessDefinition\.xml$/i.test(path)) {
      throw new Error("LbpmProcessDefinition translation requires the paired SysFormTemplate; pass the source directory");
    }
    throw new Error("v2 currently supports source directories or *_SysFormTemplate.xml source files");
  }
  const xml = readFileSync(path, "utf8");
  return translateSysFormTemplateXml(xml, {
    sourcePath: path,
    functionWhitelist: options.functionWhitelist
  });
}

function translateSourceDirectory(path, options = {}) {
  const entries = readdirSync(path);
  const sysFormName = requireSingle(entries, /_SysFormTemplate\.xml$/i, "SysFormTemplate");
  const lbpmProcessName = requireSingle(entries, /_LbpmProcessDefinition\.xml$/i, "LbpmProcessDefinition");
  const sysFormPath = join(path, sysFormName);
  const lbpmProcessPath = join(path, lbpmProcessName);

  const formDsl = translateSysFormTemplateXml(readFileSync(sysFormPath, "utf8"), {
    sourcePath: sysFormPath,
    functionWhitelist: options.functionWhitelist
  });
  const workflowDsl = translateLbpmProcessDefinitionXml(readFileSync(lbpmProcessPath, "utf8"), {
    sourcePath: lbpmProcessPath
  });

  const formTemplateId = formDsl.source.fdModelId;
  const processTemplateId = workflowDsl.source.templateId;
  if (formTemplateId && processTemplateId && formTemplateId !== processTemplateId) {
    throw new Error(`source directory template mismatch: SysFormTemplate fdModelId ${formTemplateId} does not match LbpmProcessDefinition templateId ${processTemplateId}`);
  }

  return {
    ...formDsl,
    source: {
      kind: "km-review-template-source-directory",
      path,
      sysFormTemplate: formDsl.source,
      lbpmProcessDefinition: workflowDsl.source
    },
    workflow: workflowDsl.workflow
  };
}

function requireSingle(entries, pattern, label) {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new Error(`source directory requires exactly one ${label} XML file; found ${matches.length}`);
  }
  return matches[0];
}
