import { useEffect } from 'react';
import { KitchenSink } from './pages/KitchenSink';
import { NotFound } from './pages/NotFound';
import { Overview } from './pages/Overview';
import { ROUTES, useHashRoute } from './route';
import { Shell } from './Shell';

export function App() {
  const route = useHashRoute();
  const def = ROUTES.find((r) => r.path === route);
  useEffect(() => {
    document.title = def === undefined ? 'Not found - Spooky' : `${def.title} - Spooky`;
  }, [def]);
  return (
    <Shell route={route}>
      {route === '/' ? <Overview /> : route === '/kitchen-sink' ? <KitchenSink /> : <NotFound />}
    </Shell>
  );
}
