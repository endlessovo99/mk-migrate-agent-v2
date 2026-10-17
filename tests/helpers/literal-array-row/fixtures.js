const hidden = id => ({ id, type: "text", componentId: "xform-hidden", sourceProps: { designerId: id, metadataId: id, metadataAttributes: { type: "String" }, hardHidden: true } });
const input = id => ({ id, type: "text", componentId: "xform-input", sourceProps: { designerId: id, metadataId: id, metadataAttributes: { type: "String" } } });
export const form = { fields: [
  { id: "choice", type: "radio", componentId: "xform-radio", sourceProps: { designerId: "choice", metadataId: "choice" } },
  hidden("memo"), hidden("alternate"), input("payload"), input("otherPayload")
], layout: { mkTree: [
  { id: "layout.rowOne", sourceMarkers: ["first_row"], children: [{ refType: "field", refIds: ["payload"] }] },
  { id: "layout.rowTwo", sourceMarkers: ["second_row"], children: [{ refType: "field", refIds: ["otherPayload"] }] }
] } };
export const row = (visible = true, marker = "first_row") => 'common_dom_row_set_show_required_reset(' + JSON.stringify(marker) + ',' + visible + ',false,false);';
export const membership = 'var current=GetXFormFieldById("memo")[0].value;var allowed=["A","B"];if(allowed.indexOf(current)>=0){' + row(true) + '}else{' + row(false) + '}';
export const load = body => 'Com_AddEventListener(window,"load",function(){' + body + '});';
export const timer = body => load('setTimeout(function(){' + body + '},510);');
export const change = body => 'AttachXFormValueChangeEventById("choice",function(changed,element){' + body + '});';
export const helper = 'function synchronizeRows(){' + membership + '}';
export const helperLifecycle = helper + '\n' + timer('synchronizeRows();') + '\n' + change('var mirror=GetXFormFieldById("memo")[0];mirror.value=changed;synchronizeRows();');
export const source = javascript => ({ id: "generic.script.1", sourceRef: "source.form.jsp.generic.script.1", displayGate: "xform:editShow", javascript, functionAudit: { matched: [], violations: [] } });
