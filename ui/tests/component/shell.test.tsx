import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { parseHash } from '../../src/app/route';
import { renderApp } from '../helpers/app';

describe('app shell', () => {
  it('has the landmarks: banner, labelled primary navigation, main, contentinfo, and a skip link first', async () => {
    renderApp();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Overview', 'Kitchen sink']);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent('Skip to content');
    await screen.findByText(/Connected/);
  });

  it('marks the current page with aria-current and gives the document a matching title', async () => {
    renderApp('#/kitchen-sink');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Kitchen sink' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(document.title).toBe('Kitchen sink - Spooky');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Kitchen sink');
  });

  it('navigates by keyboard and moves focus to the content after a navigation', async () => {
    const user = userEvent.setup();
    renderApp('#/');
    await screen.findByText(/Connected/);
    await user.click(screen.getByRole('link', { name: 'Kitchen sink' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Kitchen sink'));
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('the skip link focuses main without touching the route', async () => {
    const user = userEvent.setup();
    renderApp('#/kitchen-sink');
    await user.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.location.hash).toBe('#/kitchen-sink');
  });

  it('an unknown route says so and keeps the shell', () => {
    renderApp('#/nope');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nothing here');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(document.title).toBe('Not found - Spooky');
  });

  it('reacts to hashchange', async () => {
    renderApp('#/');
    await screen.findByText(/Connected/);
    act(() => {
      window.location.hash = '#/kitchen-sink';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Kitchen sink' })).toBeInTheDocument();
  });

  it('parseHash only accepts simple lowercase paths and treats anything else as home', () => {
    expect(parseHash('')).toBe('/');
    expect(parseHash('#/kitchen-sink')).toBe('/kitchen-sink');
    expect(parseHash('#/a/b')).toBe('/a/b'); // unknown, so the not-found page
    expect(parseHash('#/<script>')).toBe('/');
    expect(parseHash('#//evil.example')).toBe('/');
  });
});
