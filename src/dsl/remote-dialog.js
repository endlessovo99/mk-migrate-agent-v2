import {omittedSelectorBinding} from "./omitted-remote-selector.js";
import {remoteSelectorBinding} from "./native-remote-selector-profile.js";
const remoteKinds = new Set(['sqldialog', 'restdialog']);
const normalized = value => typeof value === 'string' ? value.toLowerCase() : '';
const own = (value, key) => Object.hasOwn(value || {}, key);
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

const list = value => Array.isArray(value) ? value : [];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(form = {}, includeTables = false) {
  if (!record(form)) return [];
  let entries;
  if (Array.isArray(form.fields)) entries = form.fields.flatMap((field, index) => field?.type === 'detailTable'
    ? [...(includeTables ? [{field, path: `/form/fields/${index}`}] : []),
      ...list(field.columns).map((column, i) => ({field: column, path: `/form/fields/${index}/columns/${i}`}))]
    : [{field, path: `/form/fields/${index}`}]);
  else entries = [
    ...list(form.controls).map((field, index) => ({field, path: `/form/controls/${index}`})),
    ...list(form.dataFields).map((field, index) => ({field, path: `/form/dataFields/${index}`})),
    ...list(form.detailTables).flatMap((table, index) => [
      ...(includeTables ? [{field: table, path: `/form/detailTables/${index}`}] : []),
      ...list(table?.columns).map((field, i) => ({field, path: `/form/detailTables/${index}/columns/${i}`}))])
  ];
  return entries.filter(({field}) => record(field));
}

function declaration(field) {
  const props = field.sourceProps || {};
  const kinds = [field.sourceType, props.designerType].map(normalized).filter(value => remoteKinds.has(value));
  if (!kinds.length) return;
  const kind = kinds[0];
  // sourceType may be the existing generic scalar projection; an explicit Designer declaration is authoritative evidence, including a conflict.
  const conflict = kinds.some(value => value !== kind) || own(props, 'designerType') && normalized(props.designerType) !== kind;
  return {kind, conflict};
}

function diagnostic(prefix, reason, path, field) {
  return {level: 'error', code: `${prefix}.remote_dialog_${reason}`,
    message: reason === 'unbound' ? 'The source remote selector has no verified target lookup, dual-value and callback implementation.'
      : 'Remote selector identity, declarations and source configuration must remain unambiguous and unchanged.',
    path, details: {fieldId: field.id, sourceRef: field.sourceRef}};
}

/** Unproved controls stay blocked; only the complete fixed source-policy binding is admitted. */
export function remoteDialogDiagnostics(form, {prefix = 'dsl.form', dsl} = {}) {
  return fields(form).flatMap(({field, path}) => {
    const declared = declaration(field);
    if (!declared) return [];
    if (!declared.conflict && (remoteSelectorBinding(dsl,field)||omittedSelectorBinding(dsl,field))) return [];
    return [diagnostic(prefix, declared.conflict ? 'source_type_conflict' : 'unbound', path, field)];
  });
}

/** Compare with fixed Source Draft occurrences rather than a candidate's editable hints. Never put raw query/configuration values into diagnostics. */
export function remoteDialogSourceDiagnostics(sourceForm, candidateForm, {prefix = 'trust.form', dsl} = {}) {
  const source = fields(sourceForm), identities = fields(sourceForm, true), target = fields(candidateForm, true), diagnostics = [];
  for (const {field, path} of source) {
    const declared = declaration(field);
    if (!declared) continue;
    if (declared.conflict || !(remoteSelectorBinding(dsl, target.find(entry=>entry.field.sourceRef===field.sourceRef)?.field || {})||omittedSelectorBinding(dsl,target.find(entry=>entry.field.sourceRef===field.sourceRef)?.field || {}))) diagnostics.push(diagnostic(prefix, declared.conflict ? 'source_type_conflict' : 'unbound', path, field));
    const sameSource = identities.filter(entry => entry.field.sourceRef === field.sourceRef);
    if (!field.sourceRef || sameSource.length !== 1) diagnostics.push(diagnostic(prefix, 'source_ref_ambiguous', path, field));
    const matches = target.filter(entry => entry.field.sourceRef === field.sourceRef);
    const actual = matches[0]?.field;
    const fact = value => ({designerId: value?.sourceProps?.designerId, designerType: value?.sourceProps?.designerType,
      designerValues: value?.sourceProps?.designerValues, restDialog: value?.sourceProps?.restDialog});
    if (matches.length !== 1 || canonical(fact(field)) !== canonical(fact(actual))) {
      diagnostics.push(diagnostic(prefix, 'source_mismatch', path, field));
    }
  }
  return diagnostics;
}
