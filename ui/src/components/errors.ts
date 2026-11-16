import { ApiError } from '../api/client';

/** Anything thrown while talking to the server, as the typed error the screens show. */
export function toApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', 'something went wrong in the page');
}

export interface ErrorCopy {
  title: string;
  hint?: string;
}

/** What each typed code means for the person using the page. The server's own message is shown next to it, as text. */
export const ERROR_COPY: Readonly<Record<string, ErrorCopy>> = {
  UNAUTHORIZED: { title: 'The server needs a valid API token.', hint: 'Enter the token in the form that appears, or under Settings.' },
  FORBIDDEN: { title: 'The server refused this request.' },
  RATE_LIMITED: { title: 'Too many requests.', hint: 'Wait a moment and try again.' },
  OVERLOADED: { title: 'The server is busy.', hint: 'Try again in a moment.' },
  REQUEST_TIMEOUT: { title: 'The request took too long.', hint: 'Try again, or use shorter text.' },
  INPUT_TOO_LARGE: { title: 'That text is longer than the server accepts.', hint: 'Shorten it, or raise limits.maxInputChars in the server config.' },
  USAGE: { title: 'The server did not accept that request.', hint: 'Check the fields and try again.' },
  UNKNOWN_PERSONA: { title: 'That persona does not exist.', hint: 'Choose one from the list.' },
  UNKNOWN_AUTHOR: { title: 'That author does not exist.', hint: 'Choose an author from the list, or ingest one first.' },
  LLM_FAILED: { title: 'The model call failed.', hint: 'Nothing was saved. Try again.' },
  FILTER_FAILED: { title: 'A safety filter could not run, so no text was returned.', hint: 'Nothing was released. Try again.' },
  DETECTORS_FAILED: { title: 'The configured detectors failed.', hint: 'Try again, or score locally only.' },
  PROFILE_INVALID: { title: 'The stored author profile is invalid.' },
  STORE_CORRUPT: { title: 'The server state is damaged.', hint: 'See the server log.' },
  STATE_LOCKED: { title: 'Another process is using the server state.', hint: 'Try again in a moment.' },
  CONFIG_INVALID: { title: 'The server configuration is invalid.' },
  NETWORK: { title: 'The server could not be reached.', hint: 'Check that ghostwriter serve is running.' },
  BAD_TOKEN: { title: 'The token contains unsupported characters.', hint: 'Paste the token again, exactly as the server printed it.' },
  ABORTED: { title: 'The request was cancelled.', hint: 'The server may still finish work it had already started.' },
  CLIENT_TIMEOUT: { title: 'The server did not answer in time.', hint: 'The request may still be running on the server. Try again, or use shorter text.' },
  BAD_RESPONSE: { title: 'The server sent something this page cannot read.' },
  NOT_FOUND: { title: 'The server does not have that.' },
  INTERNAL: { title: 'Something went wrong.' },
};

export function copyFor(code: string): ErrorCopy {
  return ERROR_COPY[code] ?? { title: 'The request failed.' };
}
