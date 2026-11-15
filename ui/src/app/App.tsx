import { Suspense, lazy, useEffect } from 'react';
import type { ReactNode } from 'react';
import { CapabilitiesProvider } from '../api/capabilities';
import { AnnouncerProvider } from '../components/Announcer';
import { AuthGate } from '../components/AuthGate';
import { KitchenSink } from './pages/KitchenSink';
import { NotFound } from './pages/NotFound';
import { Overview } from './pages/Overview';
import { ROUTES, useHashRoute } from './route';
import { Shell } from './Shell';

// Every feature screen is its own lazy chunk: the first paint carries the shell only.
const GenerateScreen = lazy(() => import('../screens/generate/GenerateScreen'));
const AuthorsScreen = lazy(() => import('../screens/authors/AuthorsScreen'));
const PersonasScreen = lazy(() => import('../screens/personas/PersonasScreen'));
const SettingsScreen = lazy(() => import('../screens/settings/SettingsScreen'));

const SCREENS: Record<string, ReactNode> = {
  '/generate': <GenerateScreen />,
  '/authors': <AuthorsScreen />,
  '/personas': <PersonasScreen />,
  '/settings': <SettingsScreen />,
};

export function App() {
  const route = useHashRoute();
  const def = ROUTES.find((r) => r.path === route);
  useEffect(() => {
    document.title = def === undefined ? 'Not found - Spooky' : `${def.title} - Spooky`;
  }, [def]);
  const screen = SCREENS[route];
  return (
    <AnnouncerProvider>
      <CapabilitiesProvider>
        <Shell route={route}>
          <Suspense fallback={<p role="status">Loading...</p>}>
            {route === '/' ? <Overview /> : route === '/kitchen-sink' ? <KitchenSink /> : screen !== undefined && def !== undefined ? <AuthGate title={def.title}>{screen}</AuthGate> : <NotFound />}
          </Suspense>
        </Shell>
      </CapabilitiesProvider>
    </AnnouncerProvider>
  );
}
