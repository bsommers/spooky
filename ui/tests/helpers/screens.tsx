import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { ERR, respond } from './fixtures';
import type { Overrides } from './fixtures';
import { mockClient, renderApp } from './app';

/** Every typed error code a screen has to be able to show. */
export const TYPED_CODES = [
  ['UNAUTHORIZED', 401], ['RATE_LIMITED', 429], ['OVERLOADED', 503], ['REQUEST_TIMEOUT', 408], ['INPUT_TOO_LARGE', 413], ['USAGE', 400], ['UNKNOWN_PERSONA', 404], ['UNKNOWN_AUTHOR', 404],
  ['LLM_FAILED', 502], ['FILTER_FAILED', 500], ['DETECTORS_FAILED', 502], ['PROFILE_INVALID', 422], ['STORE_CORRUPT', 500], ['STATE_LOCKED', 503], ['CONFIG_INVALID', 400], ['INTERNAL', 500],
] as const;

/** Open `hash` with `key` ("GET /api/x") failing with `code`; the banner carries the code and the server's message. */
export async function showsTypedError(hash: string, key: string, code: string, status: number): Promise<void> {
  const overrides: Overrides = { [key]: () => ({ status, body: ERR(code, `server says ${code}`) }) };
  const { unmount } = renderApp(hash, mockClient(overrides));
  const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
  await waitFor(() => expect(alert).toHaveAttribute('data-code', code));
  expect(alert).toHaveTextContent(`server says ${code}`);
  unmount();
}

/** The first request for `key` fails; "Try again" asks again and the screen shows `expectAfter`. */
export async function recoversOnRetry(hash: string, key: string, expectAfter: string | RegExp): Promise<void> {
  let failed = false;
  const client = mockClient({
    [key]: ({ method, url, body }) => {
      if (failed) return respond(method, url, body);
      failed = true;
      return { status: 503, body: ERR('OVERLOADED', 'busy') };
    },
  });
  const { unmount } = renderApp(hash, client);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 }));
  expect(await screen.findByText(expectAfter, {}, { timeout: 4000 })).toBeInTheDocument();
  unmount();
}
