import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HOSTILE, PERSONAS } from '../helpers/fixtures';
import { mockClient, renderApp, renderScreen } from '../helpers/app';
import { TYPED_CODES, recoversOnRetry, showsTypedError } from '../helpers/screens';
import { describeViolations, runAxe } from '../helpers/axe';

describe('Personas screen', () => {
  it('lists the personas and shows the first one in detail: tone fields, mandates, banned phrases', async () => {
    renderScreen('#/personas');
    const list = await screen.findByRole('listbox', { name: 'Personas' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Executive', 'Engineer']);
    const detail = screen.getByRole('region', { name: 'Executive' });
    expect(detail).toHaveTextContent('lowCognitive load'.replace('lowCognitive load', 'Cognitive load'));
    expect(detail).toHaveTextContent('lead with the decision');
    expect(detail).toHaveTextContent('Banned phrases (2)');
    expect(detail).toHaveTextContent('synergy');
  });

  it('selecting another persona by click and by keyboard changes the detail; empty lists say None', async () => {
    const user = userEvent.setup();
    renderScreen('#/personas');
    const list = await screen.findByRole('listbox', { name: 'Personas' });
    await user.click(within(list).getByRole('option', { name: 'Engineer' }));
    const detail = await screen.findByRole('region', { name: 'Engineer' });
    expect(detail).toHaveTextContent('Banned phrases (0)');
    expect(within(detail).getAllByText('None.')).toHaveLength(2);
    await user.click(within(list).getByRole('option', { name: 'Executive' }));
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('region', { name: 'Engineer' })).toBeInTheDocument();
  });

  it('is read-only: no edit controls', async () => {
    renderScreen('#/personas');
    await screen.findByRole('listbox', { name: 'Personas' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit|save|delete|add/i })).toBeNull();
  });

  it('no personas configured: an explanation, not a blank page', async () => {
    renderApp('#/personas', mockClient({ 'GET /api/personas': () => ({ status: 200, body: { ok: true, personas: [] } }) }));
    expect(await screen.findByTestId('empty')).toHaveTextContent('No personas are configured');
  });

  it('persona text with markup, script and javascript: links is shown literally', async () => {
    const hostile = {
      ok: true,
      personas: [{ key: 'x', name: HOSTILE.img, cognitiveLoad: HOSTILE.mixed, informationDensity: HOSTILE.link, structuralMandates: [HOSTILE.script], bannedPhrases: [HOSTILE.img, HOSTILE.mixed] }],
    };
    const { container } = renderApp('#/personas', mockClient({ 'GET /api/personas': () => ({ status: 200, body: hostile }) }));
    await screen.findByRole('listbox', { name: 'Personas' });
    expect(container.querySelector('main img, main script, main b, main a')).toBeNull();
    expect(screen.getAllByText(HOSTILE.img, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(HOSTILE.script, { exact: false })).toBeInTheDocument();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it.each(TYPED_CODES)('personas request failing with %s is shown by code', async (code, status) => {
    await showsTypedError('#/personas', 'GET /api/personas', code, status);
  });

  it('retry recovers', async () => {
    await recoversOnRetry('#/personas', 'GET /api/personas', 'Banned phrases (2)');
  });

  it('axe: no violations', async () => {
    const { container } = renderScreen('#/personas');
    await screen.findByRole('listbox', { name: 'Personas' });
    expect(describeViolations((await runAxe(container)).violations)).toBe('');
    void PERSONAS;
  });
});
