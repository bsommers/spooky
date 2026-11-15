import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../../src/screens/authors/AuthorsScreen';
import { AUTHORS, ERR, HOSTILE, INGEST_OK, PROFILE_TERSE, respond } from '../helpers/fixtures';
import { renderApp, mockClient, renderScreen } from '../helpers/app';
import { TYPED_CODES, recoversOnRetry, showsTypedError } from '../helpers/screens';
import { describeViolations, runAxe } from '../helpers/axe';

const ready = () => screen.findByTestId('profile');

describe('Authors and ingest screen', () => {
  it('lists the authors, loads the first author\'s profile through /api/profile, and shows numbers beside SVG bars', async () => {
    const client = mockClient();
    renderApp('#/authors', client);
    const list = await screen.findByRole('listbox', { name: 'Authors' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    const profile = await ready();
    expect(profile).toHaveTextContent('4,210 words');
    expect(profile).toHaveTextContent('however, therefore, then');
    const table = within(profile).getByRole('table', { name: 'Stylometric profile of Terse Author' });
    expect(table).toHaveTextContent('Average sentence length11.4 words');
    expect(within(table).getAllByRole('img')).toHaveLength(5);
    expect(client.calls.some((c) => c.url === '/api/profile?authorId=terse')).toBe(true);
  });

  it('choosing another author (click, then arrow keys) loads that author\'s profile', async () => {
    const user = userEvent.setup();
    const client = mockClient();
    renderApp('#/authors', client);
    const list = await screen.findByRole('listbox', { name: 'Authors' });
    await ready();
    await user.click(within(list).getByRole('option', { name: /Long Form/ }));
    await waitFor(() => expect(screen.getByTestId('profile')).toHaveTextContent('18,890 words'));
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(screen.getByTestId('profile')).toHaveTextContent('4,210 words'));
    expect(client.calls.filter((c) => c.url.startsWith('/api/profile')).map((c) => c.url)).toEqual(['/api/profile?authorId=terse', '/api/profile?authorId=long-form', '/api/profile?authorId=terse']);
  });

  it('no authors yet: an explanation, and the ingest form is right there', async () => {
    renderScreen('#/authors', { 'GET /api/authors': () => ({ status: 200, body: { ok: true, authors: [] } }) });
    expect(await screen.findByTestId('empty')).toHaveTextContent('No authors yet');
    expect(screen.getByRole('button', { name: 'Ingest' })).toBeDisabled();
  });

  it('author names and profile text with markup are shown literally', async () => {
    const hostile = { ...PROFILE_TERSE, authorId: 'h1', displayName: HOSTILE.img, commonTransitionWords: [HOSTILE.script, HOSTILE.link], preferredPunctuation: [HOSTILE.mixed] };
    const { container } = renderScreen('#/authors', {
      'GET /api/authors': () => ({ status: 200, body: { ok: true, authors: [hostile] } }),
      'GET /api/profile': () => ({ status: 200, body: { ok: true, profile: hostile } }),
    });
    await ready();
    expect(container.querySelector('main img, main script, main b, main a[href^="javascript"]')).toBeNull();
    expect(screen.getAllByText(HOSTILE.img, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('profile')).toHaveTextContent(HOSTILE.script);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  describe('ingest form', () => {
    it('Ingest stays disabled until the id is valid and a name and text are given; a bad id says why', async () => {
      const user = userEvent.setup();
      renderScreen('#/authors');
      await ready();
      const button = screen.getByRole('button', { name: 'Ingest' });
      expect(button).toBeDisabled();
      await user.type(screen.getByLabelText(/Author id/), '../etc');
      expect(await screen.findByText(/Use letters, digits, dots, dashes or underscores/)).toBeInTheDocument();
      expect(button).toBeDisabled();
      await user.clear(screen.getByLabelText(/Author id/));
      await user.type(screen.getByLabelText(/Author id/), 'new-author');
      await user.type(screen.getByLabelText(/Display name/), 'New Author');
      expect(button).toBeDisabled();
      await user.type(screen.getByLabelText(/Writing sample/), 'Some text to learn from.');
      expect(button).toBeEnabled();
    });

    async function fill(user: ReturnType<typeof userEvent.setup>) {
      await user.type(screen.getByLabelText(/Author id/), 'new-author');
      await user.type(screen.getByLabelText(/Display name/), 'New Author');
      await user.type(screen.getByLabelText(/Writing sample/), 'Some text to learn from.');
    }

    it('submits the typed fields, shows the busy state, then success; the author list is refreshed and the new author selected', async () => {
      const user = userEvent.setup();
      let release: () => void = () => undefined;
      let authors: unknown[] = AUTHORS.authors;
      const client = mockClient({
        'GET /api/authors': () => ({ status: 200, body: { ok: true, authors } }),
        'POST /api/ingest': ({ body }) => {
          expect(body).toEqual({ authorId: 'new-author', name: 'New Author', text: 'Some text to learn from.' });
          authors = [...AUTHORS.authors, INGEST_OK.profile];
          return { status: 200, body: INGEST_OK };
        },
      });
      // hold the ingest response to observe the pending state
      const post = client.post.bind(client);
      client.post = ((path: never, body: never) => new Promise((resolve) => (release = () => resolve(post(path, body))))) as never;
      renderApp('#/authors', client);
      await ready();
      await fill(user);
      await user.click(screen.getByRole('button', { name: 'Ingest' }));
      const pending = await screen.findByRole('button', { name: 'Ingesting...' });
      expect(pending).toHaveAttribute('aria-disabled', 'true');
      release();
      expect(await screen.findByTestId('ingest-done')).toHaveTextContent('Ingested new-author');
      const list = screen.getByRole('listbox', { name: 'Authors' });
      await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3));
      await waitFor(() => expect(within(list).getByRole('option', { name: /New Author/ })).toHaveAttribute('aria-selected', 'true'));
      expect(screen.getByTestId('live-region')).toHaveTextContent('Ingested New Author');
    });

    it.each(TYPED_CODES)('an ingest failing with %s shows the banner and keeps the typed text', async (code, status) => {
      const user = userEvent.setup();
      renderScreen('#/authors', { 'POST /api/ingest': () => ({ status, body: ERR(code, `server says ${code}`) }) });
      await ready();
      await fill(user);
      await user.click(screen.getByRole('button', { name: 'Ingest' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveAttribute('data-code', code);
      expect(screen.getByLabelText(/Writing sample/)).toHaveValue('Some text to learn from.');
      expect(screen.getByRole('button', { name: 'Ingest' })).toBeEnabled();
    });

    it('reads a chosen text file in the browser into the text box (nothing is sent until Ingest)', async () => {
      const user = userEvent.setup();
      const client = mockClient();
      const { container } = renderApp('#/authors', client);
      await ready();
      const before = client.calls.length;
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      await user.upload(input, new File(['Chapter one.\nIt rained.'], 'sample.txt', { type: 'text/plain' }));
      await waitFor(() => expect(screen.getByLabelText(/Writing sample/)).toHaveValue('Chapter one.\nIt rained.'));
      expect(screen.getAllByText(/Loaded sample\.txt/).length).toBeGreaterThan(0);
      expect(client.calls.length).toBe(before);
    });

    it('refuses a file over the size limit and a binary file, with a message', async () => {
      const user = userEvent.setup({ applyAccept: false });
      const { container } = renderScreen('#/authors');
      await ready();
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      const big = new File(['x'], 'big.txt', { type: 'text/plain' });
      Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
      await user.upload(input, big);
      expect(await screen.findByText(/big\.txt is larger than/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Writing sample/)).toHaveValue('');
      await user.upload(input, new File(['ab\u0000cd'], 'blob.bin', { type: 'application/octet-stream' }));
      expect(await screen.findByText(/blob\.bin does not look like a text file/)).toBeInTheDocument();
    });

    it('a pasted corpus containing markup is sent as the literal text it is', async () => {
      const user = userEvent.setup();
      let sent: unknown;
      renderScreen('#/authors', { 'POST /api/ingest': ({ body }) => ((sent = body), respond('POST', '/api/ingest', body)) });
      await ready();
      await user.type(screen.getByLabelText(/Author id/), 'x1');
      await user.type(screen.getByLabelText(/Display name/), 'X');
      await user.click(screen.getByLabelText(/Writing sample/));
      await user.paste(HOSTILE.script + HOSTILE.img);
      await user.click(screen.getByRole('button', { name: 'Ingest' }));
      await screen.findByTestId('ingest-done');
      expect((sent as { text: string }).text).toBe(HOSTILE.script + HOSTILE.img);
    });
  });

  it.each(TYPED_CODES)('the authors request failing with %s is shown by code', async (code, status) => {
    await showsTypedError('#/authors', 'GET /api/authors', code, status);
  });

  it('a profile request failing is shown by code next to the list, which stays usable', async () => {
    renderScreen('#/authors', { 'GET /api/profile': () => ({ status: 422, body: ERR('PROFILE_INVALID', 'profile is invalid') }) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-code', 'PROFILE_INVALID');
    expect(screen.getByRole('listbox', { name: 'Authors' })).toBeInTheDocument();
  });

  it('retry after a failed list load recovers', async () => {
    await recoversOnRetry('#/authors', 'GET /api/authors', 'Terse Author');
  });

  it('axe: no violations with the list, the profile and the form', async () => {
    const { container } = renderScreen('#/authors');
    await ready();
    expect(describeViolations((await runAxe(container)).violations)).toBe('');
  });

  it('keyboard: Tab reaches the list, then the id, name, text, file button and Ingest in reading order, with no trap; Ingest is skipped while disabled', async () => {
    const user = userEvent.setup();
    renderScreen('#/authors');
    await ready();
    await user.tab(); // skip link is first in the shell; the page controls follow the header
    const seen: Array<[string, string]> = [];
    for (let i = 0; i < 20 && seen.length < 12; i++) {
      await user.tab();
      const a = document.activeElement as HTMLElement;
      const r = a.getAttribute('role') ?? a.tagName.toLowerCase();
      seen.push([r, a.getAttribute('aria-label') ?? (a as HTMLInputElement).labels?.[0]?.textContent ?? a.textContent ?? '']);
    }
    const names = seen.map(([, n]) => n);
    const at = (re: RegExp) => names.findIndex((n) => re.test(n));
    expect(at(/Authors/)).toBeGreaterThanOrEqual(0);
    expect(at(/Author id/)).toBeGreaterThan(at(/Authors/));
    expect(at(/Display name/)).toBeGreaterThan(at(/Author id/));
    expect(at(/Writing sample/)).toBeGreaterThan(at(/Display name/));
    expect(at(/Choose a text file/)).toBeGreaterThan(at(/Writing sample/));
    expect(names.some((n) => n === 'Ingest')).toBe(false); // disabled: not in the tab order
    await user.type(screen.getByLabelText(/Author id/), 'a1');
    await user.type(screen.getByLabelText(/Display name/), 'A');
    await user.type(screen.getByLabelText(/Writing sample/), 'text');
    screen.getByRole('button', { name: 'Choose a text file' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Ingest' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('ingest-done')).toBeInTheDocument();
  });
});
