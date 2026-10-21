import { parse } from "acorn";

const canonical = value => JSON.stringify(value, (key, item) => ["start", "end", "raw"].includes(key) ? undefined : item);
const ast = text => { try { return canonical(parse(text, { ecmaVersion: "latest" })); } catch { return undefined; } };

/** Closed exporter-runtime shapes only. Near matches with an extra statement,
 * changed selector, callback, or traversal never acquire a bounded scope. */
export function captionDoclistScope(text, tableIds, hasRegistration) {
  const actual = ast(text);
  if (!actual) return undefined;
  const same = expected => actual === ast(expected);
  if (same("Com_IncludeFile('calculation_script.js','../sys/xform/designer/calculation/');")) return { targets: [], parentReads: [] };
  if (hasRegistration && same("Com_IncludeFile('doclist.js');")) return { targets: [], parentReads: [] };
  // No-argument native toolbar actions use the active detail table. Protect all
  // exported tables rather than guessing which table is active at event time.
  if (hasRegistration && [
    "DocList_AddRow();XFom_RestValidationElements();",
    "DocList_DeleteRow_ClearLast();XFom_RestValidationElements();",
    "DocList_MoveRow(-1);", "DocList_MoveRow(1);"
  ].some(same)) return { targets: [...tableIds], parentReads: [] };
  for (const id of tableIds) {
    if (!/^[A-Za-z_][\w]*$/.test(id)) continue;
    const table = JSON.stringify(`TABLE_DL_${id}`), wrapper = JSON.stringify(`TABLE_DL_${id}_div`);
    const result = { targets: [id], parentReads: [] };
    if (same(`DocList_Info.push(${table});`)) return result;
    const count = text.match(/i\s*<\s*(\d+)/)?.[1], delay = text.match(/\}\s*,\s*(\d+)\s*\)\s*;?\s*\}\s*\)/)?.[1];
    if (count && Number(count) <= 100 && delay && Number(delay) <= 60000 && same(
      `Com_AddEventListener(window,'load',function(){setTimeout(function(){for(var i=0;i<${count};i++){DocList_AddRow(document.getElementById(${table}))};},${delay});});`
    )) return result;
    for (const width of ["100%", "null"]) {
      const expected = `$(function(){var tb=document.getElementById(${table});var totalWidth=0;var tds=$(tb).find("tr[type='titleRow']").children();var hasPercent=false;tds.each(function(){if(!this.width||this.width+''.indexOf('%')>=0){totalWidth+=$(this).width();hasPercent=true;}else{totalWidth+=parseInt(this.width);}});var tdWidth=$(tb).parents('td').width();if(!hasPercent&&totalWidth>tdWidth)$(tb).css('width',totalWidth+'px');var tb_div=document.getElementById(${wrapper});$(tb_div).css('width',${JSON.stringify(width)});});`;
      if (same(expected)) return { targets: [id], parentReads: [`TABLE_DL_${id}`] };
    }
  }
}

export function hasStaticDoclistRegistration(scripts, tableIds) {
  return scripts.some(text => tableIds.some(id => ast(text) === ast(`DocList_Info.push(${JSON.stringify(`TABLE_DL_${id}`)});`)));
}
