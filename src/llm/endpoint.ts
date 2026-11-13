// Endpoint policy for LLM providers (CR-05). Pure: no I/O, no error classes, so config validation and the clients share it.
//
//  * Only http(s) URLs, never with embedded credentials.
//  * An API key is sent only over https, or over http to a loopback host (localhost, 127.0.0.0/8, ::1) so a local
//    Ollama / vLLM / llama.cpp keeps working. http to any other host is allowed only for keyless use.

const IPV4_LOOPBACK = /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Is `hostname` (as in `URL.hostname`) a loopback host? Exact match only: `127.0.0.1.example.com` and `localhost.evil.com` are not. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || IPV4_LOOPBACK.test(hostname) || hostname === '[::1]' || hostname === '::1';
}

export type EndpointProblem = 'invalid' | 'scheme' | 'credentials' | 'cleartext-key';

/**
 * Check `raw` as an LLM endpoint. `withKey` = a credential will be attached to requests. Returns the problem, or
 * `undefined` when the endpoint is acceptable. Never includes the URL in its result.
 */
export function endpointProblem(raw: string, withKey: boolean): EndpointProblem | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme';
  if (u.username !== '' || u.password !== '') return 'credentials';
  if (withKey && u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return 'cleartext-key';
  return undefined;
}

export const ENDPOINT_MESSAGES: Readonly<Record<EndpointProblem, string>> = {
  invalid: 'is not a valid URL',
  scheme: 'must use http or https',
  credentials: 'must not embed credentials',
  'cleartext-key': 'must use https when an API key is sent (plain http is allowed only for localhost, 127.0.0.0/8 and ::1)',
};
