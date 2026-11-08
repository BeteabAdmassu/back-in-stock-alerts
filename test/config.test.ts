import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { DEFAULT_TIMINGS } from '../src/contracts.ts';

const VALID = {
  STOCK_API_URL: 'https://stock.example/api/',
  STOCK_API_KEY: 'stock-key-value',
  RESEND_API_KEY: 'resend-key-value',
  RESEND_BASE_URL: 'http://mail.example///',
  WEBHOOK_SECRET: 'webhook-secret-value',
  ADMIN_PASSWORD: 'admin-password-value',
};

const SECRET_VALUES = Object.values(VALID);

function errorOf(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('expected loadConfig to throw');
}

test('applies defaults and trims trailing slashes', () => {
  assert.deepEqual(loadConfig(VALID), {
    port: 3000,
    dataDir: './data',
    stockApiUrl: 'https://stock.example/api',
    stockApiKey: 'stock-key-value',
    resendApiKey: 'resend-key-value',
    resendBaseUrl: 'http://mail.example',
    webhookSecret: 'webhook-secret-value',
    adminPassword: 'admin-password-value',
    emailFrom: 'Back in Stock <onboarding@resend.dev>',
    productUrlTemplate: null,
    logLevel: 'info',
    timings: DEFAULT_TIMINGS,
  });
});

test('reads every optional variable', () => {
  const config = loadConfig({
    ...VALID,
    PORT: '8080',
    DATA_DIR: '/var/data',
    EMAIL_FROM: 'Shop <shop@example.com>',
    PRODUCT_URL_TEMPLATE: 'https://shop.example/p/{sku}',
    LOG_LEVEL: 'warn',
  });
  assert.equal(config.port, 8080);
  assert.equal(config.dataDir, '/var/data');
  assert.equal(config.emailFrom, 'Shop <shop@example.com>');
  assert.equal(config.productUrlTemplate, 'https://shop.example/p/{sku}');
  assert.equal(config.logLevel, 'warn');
});

test('blank optional variables count as unset', () => {
  const config = loadConfig({ ...VALID, PORT: '', DATA_DIR: '  ', PRODUCT_URL_TEMPLATE: '' });
  assert.equal(config.port, 3000);
  assert.equal(config.dataDir, './data');
  assert.equal(config.productUrlTemplate, null);
});

for (const name of Object.keys(VALID)) {
  for (const [label, value] of [
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ] as const) {
    test(`${name} ${label} is named in the error`, () => {
      const message = errorOf({ ...VALID, [name]: value });
      assert.match(message, new RegExp(name));
    });
  }
}

test('names every missing variable at once and no others', () => {
  const message = errorOf({ STOCK_API_URL: 'https://stock.example' });
  for (const name of Object.keys(VALID)) {
    if (name === 'STOCK_API_URL') assert.doesNotMatch(message, new RegExp(name));
    else assert.match(message, new RegExp(name));
  }
});

const INVALID: [string, Record<string, string>][] = [
  ['STOCK_API_URL', { STOCK_API_URL: 'not a url sentinel-value' }],
  ['STOCK_API_URL', { STOCK_API_URL: 'ftp://sentinel-value.example' }],
  ['RESEND_BASE_URL', { RESEND_BASE_URL: 'javascript:sentinel-value' }],
  ['PORT', { PORT: 'sentinel-value' }],
  ['PORT', { PORT: '0' }],
  ['PORT', { PORT: '70000' }],
  ['PORT', { PORT: '80.5' }],
  ['PORT', { PORT: '-1' }],
  ['PRODUCT_URL_TEMPLATE', { PRODUCT_URL_TEMPLATE: 'https://sentinel-value.example/p/' }],
  ['PRODUCT_URL_TEMPLATE', { PRODUCT_URL_TEMPLATE: 'javascript:alert("{sku}")' }],
];

for (const [name, overrides] of INVALID) {
  test(`rejects ${name}=${Object.values(overrides)[0]} without echoing it`, () => {
    const message = errorOf({ ...VALID, ...overrides });
    assert.match(message, new RegExp(name));
    assert.doesNotMatch(message, /sentinel-value/);
  });
}

test('errors never include the value of any variable', () => {
  const messages = [
    errorOf({ ...VALID, ADMIN_PASSWORD: '' }),
    errorOf({ ...VALID, WEBHOOK_SECRET: undefined, PORT: 'nope' }),
    errorOf({ ...VALID, STOCK_API_URL: 'nope' }),
  ];
  for (const message of messages) {
    for (const value of SECRET_VALUES) assert.ok(!message.includes(value));
  }
});
