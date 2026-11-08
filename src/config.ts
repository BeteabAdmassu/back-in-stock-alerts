import { type AppConfig, DEFAULT_TIMINGS } from './contracts.ts';

type Env = Record<string, string | undefined>;

const REQUIRED = [
  'STOCK_API_URL',
  'STOCK_API_KEY',
  'RESEND_API_KEY',
  'RESEND_BASE_URL',
  'WEBHOOK_SECRET',
  'ADMIN_PASSWORD',
] as const;

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = './data';
const DEFAULT_EMAIL_FROM = 'Back in Stock <onboarding@resend.dev>';
const DEFAULT_LOG_LEVEL = 'info';

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, '');

/**
 * Builds the app configuration. Errors name variables and never include their values, because the
 * message is printed at startup and values may be secrets.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  // Surrounding whitespace is never meant: it comes from CRLF env files and copy-paste, and would
  // make an API key an invalid header value.
  const read = (name: string): string => env[name]?.trim() ?? '';

  const missing = REQUIRED.filter((name) => read(name) === '');
  const invalid: string[] = [];

  for (const name of ['STOCK_API_URL', 'RESEND_BASE_URL']) {
    if (read(name) !== '' && !isHttpUrl(read(name))) invalid.push(`${name} must be an http(s) URL`);
  }

  let port = DEFAULT_PORT;
  if (read('PORT') !== '') {
    port = /^\d{1,5}$/.test(read('PORT')) ? Number(read('PORT')) : 0;
    if (port < 1 || port > 65_535) invalid.push('PORT must be an integer from 1 to 65535');
  }

  const productUrlTemplate = read('PRODUCT_URL_TEMPLATE');
  if (
    productUrlTemplate !== '' &&
    (!productUrlTemplate.includes('{sku}') || !isHttpUrl(productUrlTemplate))
  ) {
    invalid.push('PRODUCT_URL_TEMPLATE must be an http(s) URL containing {sku}');
  }

  if (missing.length > 0 || invalid.length > 0) {
    const problems = [...invalid];
    if (missing.length > 0) {
      problems.unshift(`Missing required environment variables: ${missing.join(', ')}`);
    }
    throw new Error(`Invalid configuration. ${problems.join('. ')}.`);
  }

  return {
    port,
    dataDir: read('DATA_DIR') || DEFAULT_DATA_DIR,
    stockApiUrl: trimTrailingSlashes(read('STOCK_API_URL')),
    stockApiKey: read('STOCK_API_KEY'),
    resendApiKey: read('RESEND_API_KEY'),
    resendBaseUrl: trimTrailingSlashes(read('RESEND_BASE_URL')),
    webhookSecret: read('WEBHOOK_SECRET'),
    adminPassword: read('ADMIN_PASSWORD'),
    emailFrom: read('EMAIL_FROM') || DEFAULT_EMAIL_FROM,
    productUrlTemplate: productUrlTemplate || null,
    logLevel: read('LOG_LEVEL') || DEFAULT_LOG_LEVEL,
    timings: DEFAULT_TIMINGS,
  };
}
