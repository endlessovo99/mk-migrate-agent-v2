export function selectNewoaBaseUrl(cliValue, environmentValue) {
  return optionalBaseUrl(cliValue) ?? optionalBaseUrl(environmentValue);
}

function optionalBaseUrl(value) {
  return typeof value === "string" ? value.trim() || undefined : value;
}
