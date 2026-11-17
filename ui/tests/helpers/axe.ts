import axe from 'axe-core';
import type { AxeResults, Result } from 'axe-core';

/** Runs axe on `root`. jsdom has no layout or computed color, so color-contrast is covered by the numeric theme tests and
 *  by the real-browser axe run in tests/e2e/a11y.spec.ts. */
export async function runAxe(root: Element = document.body): Promise<AxeResults> {
  return axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false } },
  });
}

export const describeViolations = (vs: readonly Result[]): string =>
  vs.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}: ${n.failureSummary?.split('\n')[1] ?? ''}`).join('\n')}`).join('\n');
