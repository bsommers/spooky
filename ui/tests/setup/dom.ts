import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The full suite runs many jsdom files at once; a lazy screen plus a popover can take longer than the 1 s default under load.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
  document.documentElement.removeAttribute('style');
});

// jsdom has no layout; React Aria asks for these.
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
HTMLCanvasElement.prototype.getContext = (): null => null; // jsdom has no canvas; axe probes it for icon ligatures
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
