// Deterministic fake-secret generators. Secrets are ASSEMBLED from fragments at runtime so that no
// secret-shaped literal sits in the repository (GitHub push protection / secret scanners flag those).
// All values are random fakes; none is a real credential.
import { mulberry32, pick } from '../../helpers/prng.js';

const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64URL = ALNUM + '-_';
const B64 = ALNUM + '+/';

function chars(rnd: () => number, alphabet: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
}

export interface FakeSecret {
  /** redaction type the confidentiality filter must label it with */
  type: string;
  /** the exact strings that must not survive redaction */
  values: string[];
  /** the full text to embed (usually equals values[0]) */
  text: string;
}

export function makeSecrets(seed = 1): Record<string, () => FakeSecret> {
  const rnd = mulberry32(seed);
  const one = (type: string, text: string): FakeSecret => ({ type, values: [text], text });
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const pem = (label: string): FakeSecret => {
    const lines = Array.from({ length: 6 }, () => chars(rnd, B64, 64));
    const text = `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
    return { type: 'private_key', values: [...lines, text], text };
  };
  return {
    aws: () => one('aws_key', 'AKIA' + chars(rnd, UPPER_NUM, 16)),
    awsTemp: () => one('aws_key', 'ASIA' + chars(rnd, UPPER_NUM, 16)),
    ghp: () => one('github_token', 'gh' + 'p_' + chars(rnd, ALNUM, 36)),
    ghs: () => one('github_token', 'gh' + 's_' + chars(rnd, ALNUM, 36)),
    githubPat: () => one('github_token', 'github_' + 'pat_' + chars(rnd, ALNUM + '_', 40)),
    sk: () => one('api_key', 'sk' + '-' + chars(rnd, ALNUM, 48)),
    skProj: () => one('api_key', 'sk' + '-proj-' + chars(rnd, B64URL, 60)),
    skAnt: () => one('api_key', 'sk' + '-ant-api03-' + chars(rnd, B64URL, 80)),
    slack: () => one('slack_token', 'xo' + 'xb-' + chars(rnd, '0123456789', 12) + '-' + chars(rnd, '0123456789', 12) + '-' + chars(rnd, ALNUM, 24)),
    slackUser: () => one('slack_token', 'xo' + 'xp-' + chars(rnd, '0123456789', 12) + '-' + chars(rnd, ALNUM, 24)),
    jwt: () => {
      const text = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"1234567890","name":"x"}')}.${chars(rnd, B64URL, 43)}`;
      return one('jwt', text);
    },
    bearer: () => {
      const tok = chars(rnd, B64URL, 40);
      return { type: 'bearer_token', values: [tok], text: `Bearer ${tok}` };
    },
    stripeLive: () => one('stripe_key', 'sk' + '_live_' + chars(rnd, ALNUM, 24)),
    stripeRestricted: () => one('stripe_key', 'rk' + '_test_' + chars(rnd, ALNUM, 24)),
    google: () => one('google_api_key', 'AI' + 'za' + chars(rnd, B64URL, 35)),
    gitlab: () => one('gitlab_token', 'gl' + 'pat-' + chars(rnd, B64URL, 20)),
    npm: () => one('npm_token', 'np' + 'm_' + chars(rnd, ALNUM, 36)),
    huggingface: () => one('hf_token', 'h' + 'f_' + chars(rnd, ALNUM, 34)),
    sendgrid: () => one('sendgrid_key', 'S' + 'G.' + chars(rnd, B64URL, 22) + '.' + chars(rnd, B64URL, 43)),
    pemRsa: () => pem('RSA PRIVATE KEY'),
    pemEc: () => pem('EC PRIVATE KEY'),
    pemOpenssh: () => pem('OPENSSH PRIVATE KEY'),
    pemPkcs8: () => pem('PRIVATE KEY'),
    pemEncrypted: () => pem('ENCRYPTED PRIVATE KEY'),
  };
}

export const ALL_SECRET_KINDS = Object.keys(makeSecrets()) as readonly string[];

export function pickKind(rnd: () => number): string {
  return pick(rnd, ALL_SECRET_KINDS);
}
