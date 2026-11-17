// One polite live region for the whole app: screens call `announce("Generation finished")` and a screen reader says it.
// The text is only ever set as a text node.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

interface AnnounceValue {
  announce(message: string): void;
  message: string;
}

const AnnounceContext = createContext<AnnounceValue>({ announce: () => undefined, message: '' });

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ text: '', n: 0 });
  const announce = useCallback((message: string) => setState((s) => ({ text: message, n: s.n + 1 })), []);
  // A trailing no-break space on every other message makes an identical repeat a change the screen reader speaks again.
  const message = state.text === '' ? '' : state.text + (state.n % 2 === 0 ? ' ' : '');
  const value = useMemo(() => ({ announce, message }), [announce, message]);
  return <AnnounceContext.Provider value={value}>{children}</AnnounceContext.Provider>;
}

export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext).announce;
}

/** Rendered once, in the footer landmark. */
export function LiveRegion() {
  const { message } = useContext(AnnounceContext);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="gw-sr-only" data-testid="live-region">
      {message}
    </div>
  );
}
