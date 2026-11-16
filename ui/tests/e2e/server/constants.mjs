// Shared by the e2e server and the specs.
/** A canary standing in for a provider API key. It lives only in the server process's environment; it must never reach the browser. */
export const PLANTED_KEY = 'sk-' + 'ant-planted-canary-4f9c1e7a2b8d6035c9e1a7f4';
export const KEY_ENV = 'GW_E2E_FAKE_KEY';
/** What the scripted model answers, always: a sentence with live-looking markup inside, to prove model output is shown as text. */
export const MODEL_ANSWER = 'The release ships on Friday. <img src=x onerror="window.__pwned=1"> Questions go to the release owner.';
