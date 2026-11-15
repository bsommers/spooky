import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HUMANIZE_CAVEAT } from '../../src/screens/score/caveat';
import { CAPS_FULL, CAPS_NO_PHASE8, ERR, HOSTILE, HUMANIZE_CAVEAT_TEXT, HUMANIZE_OK, SCORE_OK } from '../helpers/fixtures';
import type { Overrides } from '../helpers/fixtures';
import { mockClient, renderApp, renderScreen } from '../helpers/app';
import { TYPED_CODES } from '../helpers/screens';
import { describeViolations, runAxe } from '../helpers/axe';

const capsWithout = (...names: string[]): Overrides => ({
  'GET /api/capabilities': () => ({ status: 200, body: { ...CAPS_FULL, operations: CAPS_FULL.operations.filter((o) => !names.includes(o.name)) } }),
});

async function openHumanize(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Humanize' }));
}
async function paste(user: ReturnType<typeof userEvent.setup>, label: RegExp | string, text: string) {
  const box = await screen.findByLabelText(label);
  await user.click(box);
  await user.paste(text);
}

describe('Score / Humanize screen: the caveat', () => {
  it('the weak-scorer caveat is on screen before anything is run, and is the registry text', async () => {
    renderScreen('#/score');
    const note = await screen.findByTestId('caveat');
    expect(note).toHaveAttribute('role', 'note');
    expect(note).toHaveTextContent(HUMANIZE_CAVEAT);
    expect(HUMANIZE_CAVEAT).toBe(HUMANIZE_CAVEAT_TEXT);
    expect(note).toHaveTextContent('held-out AUC 0.694');
    expect(note).toHaveTextContent('not a detector verdict');
  });

  it('it is still there with the Humanize tab open and with a result on screen, and the result carries the server\'s own caveat', async () => {
    const user = userEvent.setup();
    renderScreen('#/score');
    await openHumanize(user);
    expect(screen.getByTestId('caveat')).toBeInTheDocument();
    await paste(user, /Text to humanize/, 'A draft to rewrite.');
    await user.click(screen.getByRole('button', { name: 'Humanize' }));
    expect(await screen.findByTestId('server-caveat')).toHaveTextContent(HUMANIZE_OK.caveat);
    expect(screen.getByTestId('caveat')).toBeInTheDocument();
  });
});

describe('Score / Humanize screen: gating on the capability list', () => {
  it('without score and humanize the nav entry is still there, the page renders, and both panels are off with an explanation', async () => {
    const user = userEvent.setup();
    renderScreen('#/score', { 'GET /api/capabilities': () => ({ status: 200, body: CAPS_NO_PHASE8 }) });
    expect(await screen.findByTestId('unavailable')).toHaveTextContent('Scoring is not available on this server.');
    expect(screen.getByRole('heading', { level: 1, name: 'Score and humanize' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Score / Humanize' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Score' })).toBeNull();
    await openHumanize(user);
    expect(await screen.findByTestId('unavailable')).toHaveTextContent('Humanizing is not available on this server.');
    expect(screen.queryByRole('button', { name: 'Humanize' })).toBeNull();
    // other pages are not broken by it
    await user.click(screen.getByRole('link', { name: 'Personas' }));
    expect(await screen.findByRole('listbox', { name: 'Personas' })).toBeInTheDocument();
  });

  it('a server with score but without humanize gets a working Score panel and an off Humanize panel', async () => {
    const user = userEvent.setup();
    renderScreen('#/score', capsWithout('humanize'));
    await paste(user, /Text to score/, 'Some text.');
    expect(screen.getByRole('button', { name: 'Score' })).toBeEnabled();
    await openHumanize(user);
    expect(await screen.findByTestId('unavailable')).toHaveTextContent('Humanizing');
  });

  it('axe: the gated-off state has no violations', async () => {
    const { container } = renderScreen('#/score', { 'GET /api/capabilities': () => ({ status: 200, body: CAPS_NO_PHASE8 }) });
    await screen.findByTestId('unavailable');
    expect(describeViolations((await runAxe(container)).violations)).toBe('');
  });
});

describe('Score panel', () => {
  it('Score is disabled for empty and over-cap text, with a live count', async () => {
    const user = userEvent.setup();
    renderScreen('#/score');
    const button = await screen.findByRole('button', { name: 'Score' });
    expect(button).toBeDisabled();
    await paste(user, /Text to score/, 'x'.repeat(5001));
    expect(screen.getByTestId('char-count')).toHaveTextContent('5,001 / 5,000');
    expect(button).toBeDisabled();
    await user.keyboard('{Backspace}');
    expect(button).toBeEnabled();
  });

  it('shows busy, then the score, per-feature contribution with bars, the ensemble and the trace', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    let sent: unknown;
    const client = mockClient({ 'POST /api/score': ({ body }) => ((sent = body), { status: 200, body: SCORE_OK }) });
    const post = client.post.bind(client);
    client.post = ((p: never, b: never) => new Promise((resolve) => (release = () => resolve(post(p, b))))) as never;
    renderApp('#/score', client);
    await paste(user, /Text to score/, 'A paragraph of text.');
    await user.click(screen.getByRole('button', { name: 'Score' }));
    expect(await screen.findByRole('button', { name: 'Scoring...' })).toHaveAttribute('aria-disabled', 'true');
    release();
    expect(await screen.findByTestId('score-value')).toHaveTextContent('0.62');
    expect(sent).toEqual({ text: 'A paragraph of text.' });
    const feats = screen.getByRole('table', { name: 'Local heuristic features' });
    expect(within(feats).getAllByRole('row')).toHaveLength(1 + Object.keys(SCORE_OK.local.features).length);
    expect(within(feats).getAllByRole('img')).toHaveLength(3);
    expect(screen.getByRole('table', { name: 'Scorers that contributed' })).toHaveTextContent('local');
    expect(screen.getByText('uniform-sentences')).toBeInTheDocument();
    expect(screen.getByText(/Local heuristic only/)).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent('Score 0.62');
  });

  it('excluded detectors are listed with their reason, as text', async () => {
    const user = userEvent.setup();
    const body = { ...SCORE_OK, excluded: [{ name: HOSTILE.img, reason: HOSTILE.script }], localOnly: false };
    const { container } = renderScreen('#/score', { 'POST /api/score': () => ({ status: 200, body }) });
    await paste(user, /Text to score/, 'text');
    await user.click(screen.getByRole('button', { name: 'Score' }));
    await screen.findByTestId('score-value');
    expect(container.querySelector('main img, main script')).toBeNull();
    expect(screen.getByText(HOSTILE.script, { exact: false })).toBeInTheDocument();
  });

  it.each(TYPED_CODES)('score failing with %s shows the banner with that code and keeps the text', async (code, status) => {
    const user = userEvent.setup();
    renderScreen('#/score', { 'POST /api/score': () => ({ status, body: ERR(code, `server says ${code}`) }) });
    await paste(user, /Text to score/, 'text');
    await user.click(screen.getByRole('button', { name: 'Score' }));
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', code);
    expect(screen.getByLabelText(/Text to score/)).toHaveValue('text');
  });
});

describe('Humanize panel', () => {
  it('sends text, target, max iterations, the model switch and the optional author; shows before/after, deltas, history and the guard\'s reverts', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    renderScreen('#/score', { 'POST /api/humanize': ({ body }) => ((sent = body), { status: 200, body: HUMANIZE_OK }) });
    await openHumanize(user);
    await paste(user, /Text to humanize/, 'Rewrite this with 42 and 7.5.');
    await user.click(screen.getByRole('button', { name: /Author profile/ }));
    await user.click(await screen.findByRole('option', { name: 'Long Form (long-form)' }));
    await user.click(screen.getByRole('switch', { name: /Allow a model pass/ }));
    await user.click(screen.getByRole('button', { name: 'Humanize' }));
    expect(await screen.findByTestId('score-before')).toHaveTextContent('0.62');
    expect(screen.getByTestId('score-after')).toHaveTextContent('0.28');
    expect(sent).toEqual({ text: 'Rewrite this with 42 and 7.5.', target: 0.3, maxIterations: 3, llm: false, authorId: 'long-form' });
    expect(screen.getByText('The target score was reached.')).toBeInTheDocument();
    const deltas = screen.getByRole('table', { name: /Feature values before and after/ });
    expect(within(deltas).getAllByRole('row')).toHaveLength(3);
    expect(within(deltas).getAllByRole('img')).toHaveLength(2);
    expect(deltas).toHaveTextContent('punctuation_variety0.310.19-0.12');
    const history = screen.getByRole('table', { name: /Every edit the loop tried/ });
    const rows = within(history).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('improved, kept');
    expect(rows[2]).toHaveTextContent('guard rejected, reverted');
    expect(within(rows[2]!).getByRole('list', { name: 'Meaning guard reasons' })).toHaveTextContent('number 7.5 changed');
    expect(screen.getByRole('region', { name: 'Humanized text' }).textContent).toBe(HUMANIZE_OK.text);
    expect(screen.getByRole('region', { name: 'Result' })).toHaveTextContent('Edits reverted by the meaning guard1');
  });

  it('a target that was not reached says so; an empty history says no edit was attempted', async () => {
    const user = userEvent.setup();
    renderScreen('#/score', { 'POST /api/humanize': () => ({ status: 200, body: { ...HUMANIZE_OK, reachedTarget: false, steps: [], featureDeltas: {}, featuresBefore: {}, featuresAfter: {} } }) });
    await openHumanize(user);
    await paste(user, /Text to humanize/, 'text');
    await user.click(screen.getByRole('button', { name: 'Humanize' }));
    expect(await screen.findByText('The target score was not reached.')).toBeInTheDocument();
    expect(screen.getByText('No edit was attempted.')).toBeInTheDocument();
  });

  it('the output and every step\'s text fields are literal text, even when they contain markup', async () => {
    const user = userEvent.setup();
    const body = {
      ...HUMANIZE_OK,
      text: HOSTILE.img + HOSTILE.script,
      steps: [{ ...HUMANIZE_OK.steps[1]!, guard: [HOSTILE.mixed], error: HOSTILE.link }],
    };
    const { container } = renderScreen('#/score', { 'POST /api/humanize': () => ({ status: 200, body }) });
    await openHumanize(user);
    await paste(user, /Text to humanize/, 'text');
    await user.click(screen.getByRole('button', { name: 'Humanize' }));
    const out = await screen.findByRole('region', { name: 'Humanized text' });
    expect(out.textContent).toBe(body.text);
    expect(container.querySelector('main img, main script, main b, main a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it.each(TYPED_CODES)('humanize failing with %s shows the banner with that code', async (code, status) => {
    const user = userEvent.setup();
    renderScreen('#/score', { 'POST /api/humanize': () => ({ status, body: ERR(code, `server says ${code}`) }) });
    await openHumanize(user);
    await paste(user, /Text to humanize/, 'text');
    await user.click(screen.getByRole('button', { name: 'Humanize' }));
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', code);
    expect(screen.getByTestId('live-region')).toHaveTextContent(`Humanize failed: ${code}`);
  });
});

describe('keyboard and axe', () => {
  it('the tabs switch with the arrow keys and Home/End; the panel follows', async () => {
    const user = userEvent.setup();
    renderScreen('#/score');
    const score = await screen.findByRole('tab', { name: 'Score' });
    score.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Humanize' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText(/Text to humanize/)).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Score' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Humanize' })).toHaveAttribute('aria-selected', 'true');
  });

  it.each(['score idle', 'score result', 'humanize idle', 'humanize result', 'score error', 'humanize busy'] as const)('axe: %s has no violations', async (state) => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const client = mockClient({ 'POST /api/score': () => (state === 'score error' ? { status: 502, body: ERR('DETECTORS_FAILED', 'detectors failed') } : { status: 200, body: SCORE_OK }) });
    if (state === 'humanize busy') {
      const post = client.post.bind(client);
      client.post = ((p: never, b: never) => new Promise((resolve) => (release = () => resolve(post(p, b))))) as never;
    }
    const { container } = renderApp('#/score', client);
    const h = state.startsWith('humanize');
    if (h) await openHumanize(user);
    else await screen.findByRole('tab', { name: 'Score' });
    if (state !== 'score idle' && state !== 'humanize idle') {
      await paste(user, h ? /Text to humanize/ : /Text to score/, 'Some text to measure.');
      await user.click(screen.getByRole('button', { name: h ? 'Humanize' : 'Score' }));
      if (state === 'score error') await screen.findByRole('alert');
      else if (state === 'humanize busy') await screen.findByRole('button', { name: 'Humanizing...' });
      else await screen.findByTestId(h ? 'score-before' : 'score-value');
    }
    await waitFor(async () => expect(describeViolations((await runAxe(container)).violations)).toBe(''));
    release();
  });
});
