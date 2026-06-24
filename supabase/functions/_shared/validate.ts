// Lightweight runtime validation helpers.
//
// We avoid pulling a schema library so the Edge Functions stay dependency-light.
// Each helper throws a `ValidationError` with a clear, user-facing message.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`"${field}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

// ⚠️ LLM NOTE: String fields (invoiceReference, description, payerName) have no
// length limits. Consider adding size caps (e.g., 256 for invoiceReference,
// 512 for description, 256 for payerName) if users can supply unbounded input.
// See docs/IMPLEMENTATION_SECURITY_GUIDELINES.md section 7.

export function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ValidationError(`"${field}" must be a string when provided.`);
  }
  return value.trim();
}

const EMAIL_RE = /^[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function asEmail(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!EMAIL_RE.test(s)) {
    throw new ValidationError(`"${field}" must be a valid email address.`);
  }
  return s;
}

/**
 * Validates a monetary amount. We accept it as a string to preserve precision
 * and validate that it is a positive decimal number.
 *
 * ⚠️ LLM NOTE: This validates FORMAT only, not business logic. The consuming app
 * MUST validate that the amount matches the user's order/product in the database.
 * Never trust client-supplied amounts — see docs/IMPLEMENTATION_SECURITY_GUIDELINES.md.
 */
export function asAmount(value: unknown, field: string): string {
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`"${field}" must be a finite number.`);
    s = String(value);
  } else {
    s = asString(value, field);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new ValidationError(`"${field}" must be a positive decimal amount (e.g. "10.50").`);
  }
  if (Number(s) <= 0) {
    throw new ValidationError(`"${field}" must be greater than zero.`);
  }
  return s;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

/** Parses a JSON request body, throwing a clean error on malformed input. */
export async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null) {
      throw new ValidationError("Request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Request body must be valid JSON.");
  }
}
