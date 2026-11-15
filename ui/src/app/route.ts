import { useEffect, useState } from 'react';

export interface RouteDef {
  path: string;
  label: string;
  title: string;
}

/** Routes of the shell. Feature screens (Phase 11) add entries here; unknown hashes render the not-found page. */
export const ROUTES: readonly RouteDef[] = [
  { path: '/', label: 'Overview', title: 'Overview' },
  { path: '/kitchen-sink', label: 'Kitchen sink', title: 'Kitchen sink' },
];

export function parseHash(hash: string): string {
  const m = /^#(\/[a-z0-9/-]*)?$/.exec(hash);
  return m?.[1] ?? '/';
}

export function useHashRoute(): string {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
