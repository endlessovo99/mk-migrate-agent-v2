export function diagnostic({
  level = "error",
  code,
  message,
  partition,
  invariantKey,
  path,
  dslPath,
  decodePath,
  expected,
  actual,
  details
}) {
  const item = {
    level,
    code,
    message,
    path: path || dslPath || decodePath || `/${partition || "persistence"}`
  };
  if (partition) item.partition = partition;
  if (invariantKey) item.invariantKey = invariantKey;
  if (dslPath) item.dslPath = dslPath;
  if (decodePath) item.decodePath = decodePath;
  const mergedDetails = {
    ...(details || {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {})
  };
  if (Object.keys(mergedDetails).length) item.details = mergedDetails;
  return item;
}

export function projectionError(code, message, details) {
  return diagnostic({
    level: "error",
    code,
    message,
    partition: "projection",
    path: "/projection",
    details
  });
}
