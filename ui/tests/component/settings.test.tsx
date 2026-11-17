import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CONFIG, ERR, HOSTILE } from '../helpers/fixtures';
import { mockClient, renderApp, renderScreen } from '../helpers/app';
import { TYPED_CODES, recoversOnRetry, showsTypedError } from '../helpers/screens';
import { describeViolations, runAxe } from '../helpers/axe';

const SECRET = 'sk-ant-planted-0123456789abcdefghijklmnopqrstuv';

describe('Settings screen', () => {
  it('loading, then the configuration: model, limits, filters, scoring; read-only (no inputs for config)', async () => {
    renderScreen('#/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Model' })).toBeInTheDocument();
    const model = screen.getByRole('region', { name: 'Model' });
    expect(model).toHaveTextContent('anthropic');
    expect(model).toHaveTextContent('claude-example');
    expect(await screen.findByRole('table', { name: 'Configured filters' })).toHaveTextContent('confidentiality');
    expect(screen.getByRole('region', { name: 'Limits and storage' })).toHaveTextContent('5,000');
    // the only form fields on the page are the theme radios and the token box
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'password');
  });

  it('shows the key variable NAME with a set / not set status and nothing else; a leaked field is not rendered', async () => {
    const leaky = { ...CONFIG, config: { ...CONFIG.config, llm: { ...CONFIG.config.llm, apiKey: SECRET }, apiKey: SECRET } };
    const { container } = renderApp('#/settings', mockClient({ 'GET /api/config': () => ({ status: 200, body: leaky }) }));
    await screen.findByRole('heading', { level: 2, name: 'Model' });
    const model = screen.getByRole('region', { name: 'Model' });
    expect(within(model).getByText('GW_E2E_FAKE_KEY')).toBeInTheDocument();
    expect(model).toHaveTextContent('set on the server');
    expect(container.textContent).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it('shows the state directory path read-only, as plain text, with no control to change it', async () => {
    renderScreen('#/settings');
    await screen.findByRole('heading', { level: 2, name: 'Limits and storage' });
    const storage = screen.getByRole('region', { name: 'Limits and storage' });
    expect(within(storage).getByText('State directory')).toBeInTheDocument();
    expect(within(storage).getByText('/home/example/.local/state/ghostwriter')).toBeInTheDocument();
    expect(within(storage).queryByRole('textbox')).toBeNull();
    expect(within(storage).queryByRole('button')).toBeNull();
    expect(storage).toHaveTextContent('Read-only here');
  });

  it('with no state directory the screen says the server keeps nothing between runs', async () => {
    const { stateDir: _omit, ...rest } = CONFIG.config;
    renderApp('#/settings', mockClient({ 'GET /api/config': () => ({ status: 200, body: { ...CONFIG, config: rest } }) }));
    await screen.findByRole('heading', { level: 2, name: 'Limits and storage' });
    expect(screen.getByRole('region', { name: 'Limits and storage' })).toHaveTextContent('none: this server keeps nothing between runs');
  });

  it('a state directory path with markup is shown as literal text', async () => {
    const hostile = { ...CONFIG, config: { ...CONFIG.config, stateDir: HOSTILE.script } };
    const { container } = renderApp('#/settings', mockClient({ 'GET /api/config': () => ({ status: 200, body: hostile }) }));
    await screen.findByRole('heading', { level: 2, name: 'Limits and storage' });
    expect(container.querySelector('main script, main img')).toBeNull();
    expect(screen.getByText(HOSTILE.script, { exact: false })).toBeInTheDocument();
  });

  it('an unset key variable says so in words, not only in color', async () => {
    const unset = { ...CONFIG, config: { ...CONFIG.config, llm: { ...CONFIG.config.llm, apiKeyEnvSet: false } } };
    renderApp('#/settings', mockClient({ 'GET /api/config': () => ({ status: 200, body: unset }) }));
    await screen.findByRole('heading', { level: 2, name: 'Model' });
    expect(screen.getByRole('region', { name: 'Model' })).toHaveTextContent('not set on the server');
  });

  it('config text with markup is shown as literal text', async () => {
    const hostile = { ...CONFIG, config: { ...CONFIG.config, llm: { ...CONFIG.config.llm, model: HOSTILE.img }, personas: [HOSTILE.script] } };
    const { container } = renderApp('#/settings', mockClient({ 'GET /api/config': () => ({ status: 200, body: hostile }) }));
    await screen.findByRole('heading', { level: 2, name: 'Model' });
    expect(container.querySelector('main img, main script')).toBeNull();
    expect(screen.getByText(HOSTILE.img)).toBeInTheDocument();
    expect(screen.getByText(HOSTILE.script, { exact: false })).toBeInTheDocument();
  });

  it('theme radios switch the theme and persist the id only', async () => {
    const user = userEvent.setup();
    renderScreen('#/settings');
    await screen.findByRole('radiogroup', { name: 'Theme' });
    await user.click(screen.getByRole('radio', { name: 'Tron Neon' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('tron-neon');
    await user.click(screen.getByRole('radio', { name: 'Black Cat' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('black-cat');
  });

  it('the token field holds a token in memory only: used, shown as held, forgotten; never in storage', async () => {
    const user = userEvent.setup();
    const { client } = renderScreen('#/settings');
    await screen.findByRole('heading', { level: 2, name: 'Authentication' });
    expect(screen.getByRole('button', { name: 'Forget token' })).toBeDisabled();
    await user.type(screen.getByLabelText('API token'), 'memory-only-token-0123456789');
    await user.click(screen.getByRole('button', { name: 'Use token' }));
    expect(client.hasToken()).toBe(true);
    expect(screen.getByText('A token is held in memory for this page load.')).toBeInTheDocument();
    expect(screen.getByLabelText('API token')).toHaveValue('');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('memory-only');
    expect(document.body.innerHTML).not.toContain('memory-only-token');
    await user.click(screen.getByRole('button', { name: 'Forget token' }));
    expect(client.hasToken()).toBe(false);
    expect(screen.getByText(/No token is held/)).toBeInTheDocument();
  });

  it('a 401 on the capability request shows the token form instead of the screen', async () => {
    renderApp('#/settings', mockClient({ 'GET /api/capabilities': () => ({ status: 401, body: ERR('UNAUTHORIZED', 'x') }) }));
    expect(await screen.findByText('This server asks for an API token.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Model' })).toBeNull();
  });

  it.each(TYPED_CODES)('config request failing with %s is shown by code', async (code, status) => {
    await showsTypedError('#/settings', 'GET /api/config', code, status);
  });

  it('retry after a failed load recovers', async () => {
    await recoversOnRetry('#/settings', 'GET /api/config', /claude-example/);
  });

  it('axe: no violations', async () => {
    const { container } = renderScreen('#/settings');
    await screen.findByRole('table', { name: 'Configured filters' });
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    expect(describeViolations((await runAxe(container)).violations)).toBe('');
  });
});
