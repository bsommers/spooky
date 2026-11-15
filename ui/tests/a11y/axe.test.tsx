import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../../src/theme/manifest';
import { STORAGE_KEY } from '../../src/theme/engine';
import { ApiProvider } from '../../src/api/context';
import { App } from '../../src/app/App';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { CAPABILITIES, fakeClient, jsonResponse } from '../helpers/app';
import { describeViolations, runAxe } from '../helpers/axe';
import { DARK, memoryStorage, mediaWith } from '../helpers/media';

function mount(route: string, themeId: string, client = fakeClient()) {
  window.location.hash = route;
  return render(
    <ThemeProvider storage={memoryStorage({ [STORAGE_KEY]: themeId })} matchMedia={mediaWith([DARK])}>
      <ApiProvider client={client}>
        <App />
      </ApiProvider>
    </ThemeProvider>,
  );
}

describe('the axe harness itself', () => {
  it('reports a real violation (an unnamed button and an image without alt), so a zero elsewhere means something', async () => {
    render(
      <main>
        <h1>t</h1>
        <button type="button" />
        <img src="x.png" />
      </main>,
    );
    const ids = (await runAxe()).violations.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['button-name', 'image-alt']));
  });
});

describe.each(THEMES.map((t) => t.id))('axe, theme %s', (themeId) => {
  it('shell + overview: zero violations', async () => {
    mount('#/', themeId);
    await screen.findByText(/Connected/);
    expect(document.documentElement.getAttribute('data-theme')).toBe(themeId);
    const { violations } = await runAxe();
    expect(describeViolations(violations)).toBe('');
  });

  it('shell + kitchen sink: zero violations', async () => {
    mount('#/kitchen-sink', themeId);
    const { violations } = await runAxe();
    expect(describeViolations(violations)).toBe('');
  });

  it('kitchen sink with the dialog open and with the theme list open: zero violations', async () => {
    const user = userEvent.setup();
    mount('#/kitchen-sink', themeId);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await screen.findByRole('dialog');
    expect(describeViolations((await runAxe()).violations)).toBe('');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /theme/i }));
    await screen.findByRole('listbox');
    expect(describeViolations((await runAxe()).violations)).toBe('');
  });

  it('overview in its token-prompt, error and lockout states: zero violations', async () => {
    for (const reply of [
      () => jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'x' } }),
      () => jsonResponse(500, { ok: false, error: { code: 'INTERNAL', message: 'x' } }),
      () => jsonResponse(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'x' } }, { 'Retry-After': '30' }),
    ]) {
      const { unmount } = mount('#/', themeId, fakeClient(reply));
      await screen.findByRole('alert');
      expect(describeViolations((await runAxe()).violations)).toBe('');
      unmount();
    }
    expect(CAPABILITIES.ok).toBe(true);
  });
});
