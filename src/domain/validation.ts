// Pure validation and normalisation of untrusted input. Messages may be shown to customers.

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: string; message: string };

const MAX_EMAIL_LENGTH = 254;
const MAX_SKU_LENGTH = 64;
const MAX_EVENT_ID_LENGTH = 255;

// Pragmatic rather than RFC 5322: one @, a local part free of whitespace and characters that are
// only valid when quoted, and a dotted domain. The provider has the last word on deliverability.
const EMAIL_PATTERN =
  /^[^\s@<>()[\]\\,;:"]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+$/u;
const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARS = /\p{Cc}/u;

const fail = (field: string, message: string): { ok: false; field: string; message: string } => ({
  ok: false,
  field,
  message,
});

export function validateEmail(input: unknown): ValidationResult<string> {
  const field = 'email';
  if (typeof input !== 'string') return fail(field, 'Please enter your email address.');
  const email = input.trim().toLowerCase();
  if (email === '') return fail(field, 'Please enter your email address.');
  if (email.length > MAX_EMAIL_LENGTH) return fail(field, 'That email address is too long.');
  if (CONTROL_CHARS.test(email) || !EMAIL_PATTERN.test(email)) {
    return fail(field, 'Please enter a valid email address.');
  }
  return { ok: true, value: email };
}

export function validateSku(input: unknown): ValidationResult<string> {
  const field = 'sku';
  if (typeof input !== 'string') return fail(field, 'Please enter a product SKU.');
  const sku = input.trim();
  if (sku === '') return fail(field, 'Please enter a product SKU.');
  if (sku.length > MAX_SKU_LENGTH) return fail(field, 'That SKU is too long.');
  if (!SKU_PATTERN.test(sku)) {
    return fail(field, 'SKUs can only contain letters, numbers, dots, dashes and underscores.');
  }
  return { ok: true, value: sku };
}

const asRecord = (body: unknown): Record<string, unknown> | null =>
  typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;

export function validateRequestBody(body: unknown): ValidationResult<{
  email: string;
  sku: string;
}> {
  const record = asRecord(body);
  if (!record) return fail('body', 'Expected a JSON object with an email and a SKU.');
  const email = validateEmail(record.email);
  if (!email.ok) return email;
  const sku = validateSku(record.sku);
  if (!sku.ok) return sku;
  return { ok: true, value: { email: email.value, sku: sku.value } };
}

export function validateWebhookPayload(body: unknown): ValidationResult<{
  eventId: string;
  sku: string;
  quantity: number;
}> {
  const record = asRecord(body);
  if (!record) return fail('body', 'Expected a JSON object.');

  const eventId = record.event_id;
  if (
    typeof eventId !== 'string' ||
    eventId.trim() === '' ||
    eventId.length > MAX_EVENT_ID_LENGTH ||
    CONTROL_CHARS.test(eventId)
  ) {
    return fail('event_id', 'event_id must be a non-empty string of at most 255 characters.');
  }

  const sku = validateSku(record.sku);
  if (!sku.ok) return sku;

  const quantity = record.quantity;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) {
    return fail('quantity', 'quantity must be a non-negative integer.');
  }

  // Adding 0 folds -0, which JSON can express, into 0.
  return { ok: true, value: { eventId, sku: sku.value, quantity: quantity + 0 } };
}
