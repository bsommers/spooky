import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-aria-components';
import { PawIcon, Wordmark, WhiskerIcon } from '../icons';
import { LiveRegion } from '../components/Announcer';
import { Backdrop } from './Backdrop';
import { ROUTES } from './route';
import { ThemeSwitcher } from './ThemeSwitcher';

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // After a navigation, move focus to the content so keyboard and screen reader users start at the new page.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [route]);

  return (
    <>
      <Backdrop />
      <a
        className="gw-skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="gw-header">
        <WhiskerIcon className="gw-header__whiskers" size={96} />
        <a className="gw-header__brand" href="#/" aria-label="Spooky home">
          <Wordmark />
        </a>
        <nav className="gw-nav" aria-label="Primary">
          <ul className="gw-nav__list">
            {ROUTES.map((r) => (
              <li key={r.path}>
                <Link className="gw-nav__link" href={`#${r.path}`} aria-current={r.path === route ? 'page' : undefined}>
                  {r.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ThemeSwitcher />
      </header>
      <main id="main" className="gw-main" tabIndex={-1} ref={main}>
        {children}
      </main>
      <footer className="gw-footer">
        <PawIcon size={16} />
        <span>Spooky runs on this machine. Nothing on this page is loaded from the internet.</span>
        <Link className="gw-footer__link" href="/licenses/THIRD_PARTY_LICENSES.md">
          Licences
        </Link>
        <LiveRegion />
      </footer>
    </>
  );
}
