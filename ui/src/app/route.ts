import { useEffect, useState } from 'react';

export interface RouteDef {
  path: string;
  label: string;
  title: string;
}

/** Routes of the shell. Feature screens (Phase 11) add entries here; unknown hashes render the not-found page. */
export const ROUTES: readonly RouteDef[] = [
  { path: '/', label: 'Overview', title: 'Overview' },
  { path: '/generate', label: 'Generate', title: 'Generate' },
  { path: '/authors', label: 'Authors', title: 'Authors and ingest' },
  { path: '/personas', label: 'Personas', title: 'Personas' },
  { path: '/settings', label: 'Settings', title: 'Settings' },
  { path: '/kitchen-sink', label: 'Kitchen sink', title: 'Kitchen sink' },
];

/** Matches no route, so a malformed hash renders the not-found page instead of quietly showing Overview. */
export const NOT_FOUND_ROUTE = '/-not-found-';
/** The skip link's in-page target: it names the content area, never a page. */
const SKIP_TARGET = '#main';

export function parseHash(hash: string): string {
  if (hash === '' || hash === '#' || hash === SKIP_TARGET) return '/';
  const m = /^#(\/[a-z0-9/-]*)$/.exec(hash);
  return m?.[1] ?? NOT_FOUND_ROUTE;
}

export function useHashRoute(): string {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    // The skip link's own `#main` (when its click handler is bypassed) is not a navigation: keep the current page.
    const on = (): void => {
      if (window.location.hash !== SKIP_TARGET) setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
