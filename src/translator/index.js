import { readFileSync } from "node:fs";
import { translateSysFormTemplateXml } from "./sysform-template-adapter.js";

export function translateSourceFile(path) {
  if (!/_SysFormTemplate\.xml$/i.test(path)) {
    throw new Error("v2 currently supports only *_SysFormTemplate.xml source files");
  }
  const xml = readFileSync(path, "utf8");
  return translateSysFormTemplateXml(xml, { sourcePath: path });
}
