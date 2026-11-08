import type { LoginViewModel } from '../../contracts.ts';
import { esc, htmlDocument, PRODUCT_NAME } from './html.ts';

const CSS = `
body {
  display: grid;
  place-items: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.25rem;
  background: var(--page);
}
.login { width: 100%; max-width: 22rem; }
.brand { font-size: 0.875rem; font-weight: 600; color: var(--muted); margin-bottom: 0.25rem; }
h1 { font-size: 1.5rem; line-height: 1.2; letter-spacing: -0.015em; margin-bottom: 1.5rem; }
.card {
  padding: 1.5rem;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.error {
  margin-bottom: 1rem;
  padding: 0.625rem 0.75rem;
  font-size: 0.9375rem;
  color: var(--bad-ink);
  background: var(--bad-bg);
  border-radius: var(--radius-sm);
}
.button { width: 100%; margin-top: 1rem; }
`;

export const renderLogin = (vm: LoginViewModel): string => {
  const error = vm.error
    ? `<p class="error" id="login-error" role="alert">${esc(vm.error)}</p>\n`
    : '';
  const describedBy = vm.error ? ' aria-describedby="login-error" aria-invalid="true"' : '';
  return htmlDocument({
    title: `Sign in · ${PRODUCT_NAME}`,
    nonce: vm.nonce,
    css: CSS,
    noindex: true,
    body: `<main class="login">
<p class="brand">${esc(PRODUCT_NAME)}</p>
<h1>Sign in to the dashboard</h1>
<form class="card" method="post" action="/admin/login">
${error}<label for="password">Password</label>
<input type="password" name="password" id="password" autocomplete="current-password" required autofocus${describedBy}>
<button class="button" type="submit">Sign in</button>
</form>
</main>`,
  });
};
