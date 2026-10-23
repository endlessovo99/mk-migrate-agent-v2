import { resolveDirectRef } from "./form-rules.js";

const MAX_VARIANTS = 32;

/** Lower only comparisons proved by a fixed, nonempty String single-choice domain.
 * Native != does not match undefined; native = can stringify null/[] to a real
 * option code. Guard the positive comparison as well as its complement. */
export function lowerNativeSingleChoiceConditions(rule, formIndex) {
  const clauses = Array.isArray(rule.when) ? rule.when : [];
  const domains = clauses.map(clause => supportedChoiceValues(clause, formIndex));
  if (!clauses.length || !domains.every(Boolean)) return undefined;
  const logic = rule.logic === "or" ? "or" : "and";
  const positive = clauses.map((clause, index) => domains[index].map(value => [
        { ...clause, op: "notEmpty", value: "" }, { ...clause, op: "eq", value }
      ]));
  const negative = clauses.map((clause, index) => [
      [{ ...clause, op: "empty", value: "" }],
      domains[index].map(value => ({ ...clause, op: "ne", value }))
    ]);
  return {
    when: combine(positive, logic),
    else: Array.isArray(rule.else) && rule.else.length
      ? combine(negative, logic === "and" ? "or" : "and") : []
  };
}

function supportedChoiceValues(clause, index) {
  if (!["eq", "in"].includes(clause.op)) return undefined;
  const reference = resolveDirectRef(index, clause.field);
  if (reference?.kind !== "field") return undefined;
  const field = reference.field;
  if (!["xform-radio", "xform-select"].includes(field?.componentId)) return undefined;
  if (![undefined, "custom"].includes(field.props?.optionSource)) return undefined;
  const options = field.props?.options;
  if (!Array.isArray(options) || !options.length ||
      options.some(option => typeof option?.value !== "string" || !option.value.length ||
        option.type === "other" || option.value === "other_")) return undefined;
  const values = clause.op === "in" ? clause.value : [clause.value];
  if (!Array.isArray(values) || !values.length || values.some(value =>
    typeof value !== "string" || !value.length || !options.some(option => option.value === value)
  )) return undefined;
  return [...new Set(values)];
}

// A native rule supports only one flat AND/OR. Multiple AND terms implement
// disjunction without flattening nested membership complements into an OR.
function combine(groups, logic) {
  if (logic === "or") return bounded(groups.flat());
  return groups.reduce((terms, group) => {
    if (terms.length * group.length > MAX_VARIANTS) return exceeded(terms.length * group.length);
    return terms.flatMap(term => group.map(other => [...term, ...other]));
  }, [[]]);
}

function bounded(terms) {
  if (terms.length > MAX_VARIANTS) return exceeded(terms.length);
  return terms;
}

function exceeded(variantCount) {
  const error = new Error("A native single-choice condition requires too many exact rule variants.");
  error.code = "projection.form_rule.single_choice_variants_exceeded";
  error.details = { variantCount, maximum: MAX_VARIANTS };
  throw error;
}
