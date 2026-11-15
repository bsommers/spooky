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

export type EndpointProblem = 'invalid' | 'scheme' | 'credentials' | 'cleartext-key' | 'cleartext';

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

/**
 * Check `raw` as the endpoint of a score DETECTOR. Stricter than an LLM endpoint: the text sent to a detector is the
 * user's own prose (redacted, but still private), so plain http is accepted only for a loopback host, key or no key.
 */
export function detectorEndpointProblem(raw: string, withKey: boolean): EndpointProblem | undefined {
  const base = endpointProblem(raw, withKey);
  if (base !== undefined) return base;
  const u = new URL(raw);
  return u.protocol === 'http:' && !isLoopbackHost(u.hostname) ? 'cleartext' : undefined;
}

// A detector bearer token comes from an env var NAMED in the config. A config the user did not write must not be able to
// name an arbitrary variable (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, ...) and have it sent to a host of its choosing.
const DETECTOR_KEY_ENV = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|TOKEN)$/;
const OTHER_SYSTEMS_ENV = /^(?:AWS|AZURE|GCP|GOOGLE|GCLOUD|GITHUB|GH|GITLAB|NPM|SSH|DOCKER|KUBE|HOME|PATH)_|(?:^|_)(?:SECRET|PASSWORD|PASSPHRASE|PRIVATE|CREDENTIALS?)(?:_|$)/;

/** Is `name` an acceptable detector `apiKeyEnv`: upper-case, ending in `_KEY`, `_API_KEY` or `_TOKEN`, and not another system's credential? */
export function isDetectorKeyEnvName(name: string): boolean {
  return name.length <= 64 && DETECTOR_KEY_ENV.test(name) && !OTHER_SYSTEMS_ENV.test(name);
}

export const DETECTOR_KEY_ENV_MESSAGE = 'must be an upper-case variable name ending in _KEY, _API_KEY or _TOKEN (for example ACME_DETECTOR_KEY), and not a cloud, git or secret/password variable';

export const ENDPOINT_MESSAGES: Readonly<Record<EndpointProblem, string>> = {
  invalid: 'is not a valid URL',
  scheme: 'must use http or https',
  credentials: 'must not embed credentials',
  'cleartext-key': 'must use https when an API key is sent (plain http is allowed only for localhost, 127.0.0.0/8 and ::1)',
  cleartext: 'must use https (plain http is allowed only for localhost, 127.0.0.0/8 and ::1)',
};
