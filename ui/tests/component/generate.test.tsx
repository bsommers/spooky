import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HUMANIZE_CAVEAT } from '../../src/screens/score/caveat';
import { ApiError } from '../../src/api/client';
import { AUTHORS, CAPS_NO_PHASE8, CONFIG, ERR, GENERATE_OK, HOSTILE, PERSONAS } from '../helpers/fixtures';
import { mockClient, renderApp, renderScreen } from '../helpers/app';
import { TYPED_CODES, recoversOnRetry, showsTypedError } from '../helpers/screens';
import { describeViolations, runAxe } from '../helpers/axe';

const draft = () => screen.findByLabelText('Draft');
async function typeDraft(user: ReturnType<typeof userEvent.setup>, text = 'Please write the release note.') {
  const box = await draft();
  await user.click(box);
  await user.paste(text);
}

describe('Generate screen', () => {
  it('populates the author and persona selects from the API and starts with Generate disabled', async () => {
    const user = userEvent.setup();
    renderScreen('#/generate');
    const author = await screen.findByRole('button', { name: /Author/ });
    expect(author).toHaveTextContent('Terse Author (terse)');
    expect(screen.getByRole('button', { name: /Persona/ })).toHaveTextContent('Executive');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await user.click(author);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(AUTHORS.authors.map((a) => `${a.displayName} (${a.authorId})`));
  });

  it('cannot submit an empty or whitespace-only draft', async () => {
    const user = userEvent.setup();
    const client = mockClient();
    renderApp('#/generate', client);
    await typeDraft(user, '   \n ');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(screen.getByText('Write a draft to enable Generate.')).toBeInTheDocument();
    expect(client.calls.filter((c) => c.url === '/api/generate')).toHaveLength(0);
  });

  it('shows a live count against the cap; over the cap is invalid, says by how much and disables Generate; exactly at the cap is fine', async () => {
    const user = userEvent.setup();
    const cap = CONFIG.config.limits.maxInputChars;
    renderScreen('#/generate');
    await draft();
    await waitFor(() => expect(screen.getByTestId('char-count')).toHaveTextContent(`0 / ${cap.toLocaleString('en-US')} characters`));
    await user.click(screen.getByLabelText('Draft'));
    await user.paste('x'.repeat(cap));
    expect(screen.getByTestId('char-count')).toHaveTextContent('5,000 / 5,000');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
    await user.keyboard('yy');
    expect(screen.getByTestId('char-count')).toHaveTextContent('5,002 / 5,000');
    expect(await screen.findByText('2 characters over the limit of 5,000.')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft')).toBeInvalid();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(screen.getByText('The draft is over the limit.')).toBeInTheDocument();
  });

  it('sends the chosen author, persona and text; shows busy; then the output equals the API result and every trace entry is listed', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    let sent: unknown;
    const client = mockClient({ 'POST /api/generate': ({ body }) => ((sent = body), { status: 200, body: GENERATE_OK }) });
    const post = client.post.bind(client);
    client.post = ((path: never, body: never) => new Promise((resolve) => (release = () => resolve(post(path, body))))) as never;
    renderApp('#/generate', client);
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: /Persona/ }));
    await user.click(await screen.findByRole('option', { name: 'Engineer' }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('button', { name: 'Generating...' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Generating...');
    release();
    const out = await screen.findByRole('region', { name: 'Generated text' });
    expect(out.textContent).toBe(GENERATE_OK.text);
    expect(sent).toEqual({ authorId: 'terse', persona: 'engineer', text: 'Please write the release note.' });
    const rows = within(screen.getByRole('table', { name: 'Filters that ran, in order' })).getAllByRole('row');
    expect(rows).toHaveLength(1 + GENERATE_OK.trace.length);
    expect(rows[3]).toHaveTextContent('style');
    expect(rows[3]).toHaveTextContent('Yes');
    expect(rows[3]).toHaveTextContent('3.5');
    expect(rows[3]).toHaveTextContent('phrases_removed: 2');
    expect(screen.getByTestId('live-region')).toHaveTextContent(`Generation finished: ${GENERATE_OK.text.length} characters`);
  });

  it('Cancel stops a stalled request: a calm cancelled notice (not an alert), focus stays on the form, and Generate works again', async () => {
    const user = userEvent.setup();
    const client = mockClient();
    const post = client.post.bind(client);
    let calls = 0;
    client.post = ((path: never, body: never, opts?: { signal?: AbortSignal }) => {
      calls++;
      if (calls > 1) return post(path, body);
      return new Promise((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new ApiError(0, 'ABORTED', 'the request was cancelled'))));
    }) as never;
    renderApp('#/generate', client);
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.querySelector('[data-code="ABORTED"]')).not.toBeNull());
    expect(document.querySelector('[data-code="ABORTED"]')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('region', { name: 'Generated text' });
    expect(document.querySelector('[data-code="ABORTED"]')).toBeNull();
  });

  it('leaving the screen aborts the request that is in flight', async () => {
    const user = userEvent.setup();
    const client = mockClient();
    let signal: AbortSignal | undefined;
    client.post = ((_p: never, _b: never, opts?: { signal?: AbortSignal }) => ((signal = opts?.signal), new Promise(() => undefined))) as never;
    renderApp('#/generate', client);
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('button', { name: 'Cancel' });
    expect(signal?.aborted).toBe(false);
    await user.click(screen.getByRole('link', { name: 'Personas' }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('banned-phrase and confidentiality indicators are counts only', async () => {
    const user = userEvent.setup();
    renderScreen('#/generate');
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByTestId('indicator-Banned phrases')).toHaveTextContent('Banned phrases: 3 removed or replaced');
    expect(screen.getByTestId('indicator-Confidentiality')).toHaveTextContent('Confidentiality: 1 redaction');
    const ind = screen.getByRole('list', { name: 'Safety filter counts' });
    expect(ind.textContent).not.toMatch(/synergy|circle back|@/);
  });

  it('the trace can be filtered by filter name', async () => {
    const user = userEvent.setup();
    renderScreen('#/generate');
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('table', { name: 'Filters that ran, in order' });
    await user.type(screen.getByRole('searchbox', { name: /Filter the trace/ }), 'conf');
    expect(within(screen.getByRole('table', { name: 'Filters that ran, in order' })).getAllByRole('row')).toHaveLength(3);
  });

  it('model output with markup, script and javascript: links is shown as literal text and never becomes an element', async () => {
    const user = userEvent.setup();
    const hostile = { ...GENERATE_OK, text: `${HOSTILE.img}\n${HOSTILE.script}\n${HOSTILE.link}\n${HOSTILE.mixed}`, trace: [{ filter: HOSTILE.img, modified: true, ms: 1, metadata: { note: HOSTILE.script } }] };
    const { container } = renderScreen('#/generate', { 'POST /api/generate': () => ({ status: 200, body: hostile }) });
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    const out = await screen.findByRole('region', { name: 'Generated text' });
    expect(out.textContent).toBe(hostile.text);
    expect(out.children).toHaveLength(0);
    expect(container.querySelector('main img, main script, main b, main a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it.each(TYPED_CODES)('a generate call failing with %s shows the banner with that code, keeps the draft, and can be sent again', async (code, status) => {
    const user = userEvent.setup();
    let fail = true;
    renderScreen('#/generate', {
      'POST /api/generate': () => (fail ? { status, body: ERR(code, `server says ${code}`) } : { status: 200, body: GENERATE_OK }),
    });
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-code', code);
    expect(screen.getByTestId('live-region')).toHaveTextContent(`Generation failed: ${code}`);
    expect(screen.getByLabelText('Draft')).toHaveValue('Please write the release note.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('region', { name: 'Generated text' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('empty states: no authors points to the ingest page; no personas says to configure some', async () => {
    const a = renderScreen('#/generate', { 'GET /api/authors': () => ({ status: 200, body: { ok: true, authors: [] } }) });
    expect(await screen.findByTestId('empty')).toHaveTextContent('There are no authors yet');
    expect(screen.getByRole('link', { name: 'Ingest a writing sample' })).toHaveAttribute('href', '#/authors');
    a.unmount();
    renderScreen('#/generate', { 'GET /api/personas': () => ({ status: 200, body: { ok: true, personas: [] } }) });
    expect(await screen.findByTestId('empty')).toHaveTextContent('No personas are configured');
  });

  it.each([['GET /api/authors'], ['GET /api/personas'], ['GET /api/config']])('%s failing is shown by code', async (key) => {
    await showsTypedError('#/generate', key, 'LLM_FAILED', 502);
  });

  it('retry after a failed load recovers', async () => {
    await recoversOnRetry('#/generate', 'GET /api/personas', /^Draft$/);
  });

  it('Copy output uses the clipboard and announces; without a clipboard it says so', async () => {
    const user = userEvent.setup();
    renderScreen('#/generate');
    await typeDraft(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('region', { name: 'Generated text' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(writeText).toHaveBeenCalledWith(GENERATE_OK.text);
    await waitFor(() => expect(screen.getByTestId('live-region')).toHaveTextContent('Copied to the clipboard'));
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(screen.getByRole('button', { name: /Copied|Copy output/ }));
    await waitFor(() => expect(screen.getByTestId('live-region')).toHaveTextContent('Copy is not available'));
  });

  describe('humanize option (Phase 8)', () => {
    it('is offered when the server lists humanize and sends humanize + target', async () => {
      const user = userEvent.setup();
      let sent: unknown;
      renderScreen('#/generate', { 'POST /api/generate': ({ body }) => ((sent = body), { status: 200, body: GENERATE_OK }) });
      await typeDraft(user);
      await user.click(screen.getByRole('switch', { name: 'Humanize the result' }));
      const target = screen.getByRole('textbox', { name: /Target score/ });
      await user.clear(target);
      await user.type(target, '0.4');
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByRole('region', { name: 'Generated text' });
      expect(sent).toMatchObject({ humanize: true, target: 0.4 });
    });

    it('shows the server\'s configured humanize target and omits it from the request until the user edits it', async () => {
      const user = userEvent.setup();
      const bodies: unknown[] = [];
      const config = { ...CONFIG, config: { ...CONFIG.config, humanize: { targetScore: 0.2, maxIterations: 5 } } };
      renderScreen('#/generate', { 'GET /api/config': () => ({ status: 200, body: config }), 'POST /api/generate': ({ body }) => (bodies.push(body), { status: 200, body: GENERATE_OK }) });
      await typeDraft(user);
      await user.click(screen.getByRole('switch', { name: 'Humanize the result' }));
      expect(screen.getByRole('textbox', { name: /Target score/ })).toHaveValue('0.2');
      await user.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByRole('region', { name: 'Generated text' });
      expect(bodies[0]).toMatchObject({ humanize: true });
      expect(bodies[0]).not.toHaveProperty('target');
    });

    it('clearing the target disables Generate with a named reason, and no request carries null', async () => {
      const user = userEvent.setup();
      const bodies: unknown[] = [];
      renderScreen('#/generate', { 'POST /api/generate': ({ body }) => (bodies.push(body), { status: 200, body: GENERATE_OK }) });
      await typeDraft(user);
      await user.click(screen.getByRole('switch', { name: 'Humanize the result' }));
      const target = screen.getByRole('textbox', { name: /Target score/ });
      await user.clear(target);
      await user.tab(); // the field commits on blur
      expect(await screen.findByText(/^Enter a number from 0 to 1/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
      expect(screen.getByText('Enter a target score from 0 to 1.')).toBeInTheDocument();
      await user.click(target);
      await user.type(target, '0.5');
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByRole('region', { name: 'Generated text' });
      expect(bodies).toEqual([{ authorId: 'terse', persona: 'exec', text: 'Please write the release note.', humanize: true, target: 0.5 }]);
    });

    it('shows the weak-scorer caveat (the registry text) while the switch is on and while a humanized result is on screen, and not otherwise', async () => {
      const user = userEvent.setup();
      renderScreen('#/generate');
      await typeDraft(user);
      expect(screen.queryByTestId('caveat')).toBeNull();
      await user.click(screen.getByRole('switch', { name: 'Humanize the result' }));
      expect(screen.getByTestId('caveat')).toHaveTextContent(HUMANIZE_CAVEAT);
      await user.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByRole('region', { name: 'Generated text' });
      await user.click(screen.getByRole('switch', { name: 'Humanize the result' })); // off again, the humanized result stays
      expect(screen.getByTestId('caveat')).toBeInTheDocument();
    });

    it('is not offered, and never sent, when the server does not list it', async () => {
      const user = userEvent.setup();
      let sent: unknown;
      renderScreen('#/generate', {
        'GET /api/capabilities': () => ({ status: 200, body: CAPS_NO_PHASE8 }),
        'POST /api/generate': ({ body }) => ((sent = body), { status: 200, body: GENERATE_OK }),
      });
      await typeDraft(user);
      expect(screen.queryByRole('switch')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByRole('region', { name: 'Generated text' });
      expect(sent).not.toHaveProperty('humanize');
    });
  });

  describe('keyboard', () => {
    it('the persona select opens with Enter, arrows move, Enter chooses, Escape closes without changing', async () => {
      const user = userEvent.setup();
      renderScreen('#/generate');
      const persona = await screen.findByRole('button', { name: /Persona/ });
      persona.focus();
      await user.keyboard('{Enter}');
      const list = await screen.findByRole('listbox');
      expect(list).toBeInTheDocument();
      await user.keyboard('{ArrowDown}{Enter}');
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      expect(persona).toHaveTextContent('Engineer');
      await waitFor(() => expect(persona).toHaveFocus()); // focus returns to the trigger when the list closes
      await user.keyboard('{Enter}');
      await screen.findByRole('listbox');
      await user.keyboard('{ArrowUp}{Escape}');
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      expect(persona).toHaveTextContent('Engineer');
      await waitFor(() => expect(persona).toHaveFocus());
    });

    it('Tab order: author, persona, draft, then Generate once it is enabled; Space activates the button; no trap', async () => {
      const user = userEvent.setup();
      renderScreen('#/generate');
      const author = await screen.findByRole('button', { name: /Author/ });
      author.focus();
      await user.tab();
      expect(screen.getByRole('button', { name: /Persona/ })).toHaveFocus();
      await user.tab();
      expect(screen.getByLabelText('Draft')).toHaveFocus();
      await user.keyboard('A draft');
      await user.tab();
      expect(screen.getByRole('switch')).toHaveFocus();
      await user.tab();
      const go = screen.getByRole('button', { name: 'Generate' });
      expect(go).toHaveFocus();
      await user.keyboard(' ');
      await screen.findByRole('region', { name: 'Generated text' });
      await user.tab(); // moves on to the output region (focusable, scrollable) then the rest; never stuck
      expect(go).not.toHaveFocus();
    });
  });

  describe('axe', () => {
    it.each(['idle', 'over the cap', 'busy', 'error', 'result'] as const)('%s state has no violations', async (state) => {
      const user = userEvent.setup();
      let release: () => void = () => undefined;
      const client = mockClient({
        'POST /api/generate': () => (state === 'error' ? { status: 502, body: ERR('LLM_FAILED', 'the model call failed') } : { status: 200, body: GENERATE_OK }),
      });
      if (state === 'busy') {
        const post = client.post.bind(client);
        client.post = ((p: never, b: never) => new Promise((resolve) => (release = () => resolve(post(p, b))))) as never;
      }
      const { container } = renderApp('#/generate', client);
      await typeDraft(user, state === 'over the cap' ? 'x'.repeat(5001) : 'Draft text');
      if (state === 'busy' || state === 'error' || state === 'result') await user.click(screen.getByRole('button', { name: 'Generate' }));
      if (state === 'busy') await screen.findByRole('button', { name: 'Generating...' });
      if (state === 'error') await screen.findByRole('alert');
      if (state === 'result') await screen.findByRole('region', { name: 'Generated text' });
      expect(describeViolations((await runAxe(container)).violations)).toBe('');
      release();
      void PERSONAS;
    });
  });
});
