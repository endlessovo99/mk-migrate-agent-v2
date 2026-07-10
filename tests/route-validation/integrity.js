export class RouteIntegrityError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "RouteIntegrityError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function integrityError(code, message, details) {
  return new RouteIntegrityError(code, message, details);
}
