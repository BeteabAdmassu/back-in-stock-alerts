import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateEmail,
  validateRequestBody,
  validateSku,
  validateWebhookPayload,
} from '../src/domain/validation.ts';

const NON_STRINGS: unknown[] = [undefined, null, 5, true, ['a@b.co'], { value: 'a@b.co' }];

test('email: valid values are normalised', () => {
  const cases: [string, string][] = [
    ['a@example.com', 'a@example.com'],
    ['  Ada.Lovelace+tag@Example.CO.UK \n', 'ada.lovelace+tag@example.co.uk'],
    ["o'brien@example.ie", "o'brien@example.ie"],
    [`${'a'.repeat(242)}@example.com`, `${'a'.repeat(242)}@example.com`],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(validateEmail(input), { ok: true, value: expected }, input);
  }
});

test('email: invalid values are rejected with a field and message', () => {
  const cases: unknown[] = [
    ...NON_STRINGS,
    '',
    '   ',
    'plain',
    'a@b',
    '@example.com',
    'a@',
    'a@@example.com',
    'a b@example.com',
    'a\tb@example.com',
    'a\u0000b@example.com',
    'a@exa mple.com',
    'a@-example.com',
    'a@example-.com',
    'a@example..com',
    '<script>@example.com',
    'a@example.com,b@example.com',
    'a@example.com\r\nBcc: b@example.com',
    `${'a'.repeat(243)}@example.com`,
  ];
  for (const input of cases) {
    const result = validateEmail(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) {
      assert.equal(result.field, 'email');
      assert.ok(result.message.length > 0);
    }
  }
});

test('sku: valid values are trimmed and keep their case', () => {
  const cases: [string, string][] = [
    ['ABC-123', 'ABC-123'],
    ['  aBc_1.2 ', 'aBc_1.2'],
    ['a', 'a'],
    ['A'.repeat(64), 'A'.repeat(64)],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(validateSku(input), { ok: true, value: expected }, input);
  }
});

test('sku: invalid values are rejected', () => {
  const cases: unknown[] = [
    ...NON_STRINGS,
    '',
    '   ',
    '-abc',
    '.abc',
    '_abc',
    'a b',
    'a/b',
    '../etc',
    'a\nb',
    'a?b',
    '<script>alert(1)</script>',
    '"><img src=x>',
    'é',
    'A'.repeat(65),
  ];
  for (const input of cases) {
    const result = validateSku(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) assert.equal(result.field, 'sku');
  }
});

test('request body: reports the first invalid field', () => {
  assert.deepEqual(validateRequestBody({ email: ' A@B.co ', sku: ' x1 ', extra: 1 }), {
    ok: true,
    value: { email: 'a@b.co', sku: 'x1' },
  });
  const cases: [unknown, string][] = [
    [null, 'body'],
    [[], 'body'],
    ['text', 'body'],
    [{}, 'email'],
    [{ email: 'a@b.co' }, 'sku'],
    [{ email: 'bad', sku: 'x' }, 'email'],
    [{ email: ['a@b.co'], sku: 'x' }, 'email'],
    [{ email: 'a@b.co', sku: ['x'] }, 'sku'],
    [{ email: 'a@b.co', sku: 5 }, 'sku'],
  ];
  for (const [input, field] of cases) {
    const result = validateRequestBody(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.field, field);
  }
});

test('webhook: valid payloads ignore extra fields', () => {
  assert.deepEqual(
    validateWebhookPayload({
      event_id: 'evt_1',
      sku: ' Sku-1 ',
      quantity: 0,
      type: 'stock.updated',
      occurred_at: 'now',
    }),
    { ok: true, value: { eventId: 'evt_1', sku: 'Sku-1', quantity: 0 } },
  );
  const longId = 'e'.repeat(255);
  assert.equal(validateWebhookPayload({ event_id: longId, sku: 'x', quantity: 5 }).ok, true);
});

test('webhook: -0 folds to 0', () => {
  const result = validateWebhookPayload(JSON.parse('{"event_id":"e","sku":"x","quantity":-0}'));
  assert.ok(result.ok);
  assert.ok(Object.is(result.value.quantity, 0));
});

test('webhook: invalid payloads name the field', () => {
  const good = { event_id: 'evt_1', sku: 'x', quantity: 1 };
  const cases: [unknown, string][] = [
    [null, 'body'],
    [[good], 'body'],
    ['{}', 'body'],
    [{ ...good, event_id: undefined }, 'event_id'],
    [{ ...good, event_id: '' }, 'event_id'],
    [{ ...good, event_id: '   ' }, 'event_id'],
    [{ ...good, event_id: 5 }, 'event_id'],
    [{ ...good, event_id: ['a'] }, 'event_id'],
    [{ ...good, event_id: 'e'.repeat(256) }, 'event_id'],
    [{ ...good, event_id: 'a\nb' }, 'event_id'],
    [{ ...good, event_id: 'a\u0000b' }, 'event_id'],
    [{ ...good, sku: undefined }, 'sku'],
    [{ ...good, sku: '<x>' }, 'sku'],
    [{ ...good, sku: 5 }, 'sku'],
    [{ ...good, quantity: undefined }, 'quantity'],
    [{ ...good, quantity: null }, 'quantity'],
    [{ ...good, quantity: '5' }, 'quantity'],
    [{ ...good, quantity: -1 }, 'quantity'],
    [{ ...good, quantity: 1.5 }, 'quantity'],
    [{ ...good, quantity: 1e300 }, 'quantity'],
    [{ ...good, quantity: [1] }, 'quantity'],
    [{ ...good, quantity: true }, 'quantity'],
  ];
  for (const [input, field] of cases) {
    const result = validateWebhookPayload(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) assert.equal(result.field, field, JSON.stringify(input));
  }
});
