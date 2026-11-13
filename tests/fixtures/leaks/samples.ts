// Leak corpus: realistic documents with fake secrets embedded in awkward places (code fences, URLs, JSON, env files,
// YAML, logs, shell history). Built at runtime from tests/fixtures/leaks/secrets.ts, deterministic per seed.
import { makeSecrets } from './secrets.js';

export interface LeakSample {
  id: string;
  text: string;
  /** exact strings that must not appear in any output */
  secrets: string[];
}

export const BLOCKLIST = ['Project Falcon', 'Acme Corp', 'Acme', 'Zed(Internal)+'] as const;

type Wrap = (s: string) => string;

const MULTI_LINE_KINDS = new Set(['pemRsa', 'pemEc', 'pemOpenssh', 'pemPkcs8', 'pemEncrypted']);

const CONTEXTS: Record<string, { wrap: Wrap; singleLineOnly?: boolean }> = {
  plain: { wrap: (s) => `Here is the value you asked for: ${s}. Please keep it safe.` },
  fence: { wrap: (s) => `Run this:\n\n\`\`\`bash\nexport SERVICE_VALUE=${s}\n./deploy.sh\n\`\`\`\n\nThen restart.` },
  json: { wrap: (s) => JSON.stringify({ service: 'billing', credentials: { value: s }, retries: 3 }, null, 2) },
  yaml: { wrap: (s) => `service: billing\nauth:\n  value: ${s.includes('\n') ? '|\n    ' + s.replace(/\n/g, '\n    ') : s}\nreplicas: 2\n` },
  envfile: { wrap: (s) => `NODE_ENV=production\nSERVICE_VALUE=${s}\nPORT=8080\n`, singleLineOnly: true },
  urlParam: { wrap: (s) => `Callback: https://app.example.invalid/cb?state=1&token=${s}&next=/home`, singleLineOnly: true },
  inline: { wrap: (s) => `Set the header to \`${s}\` and retry.`, singleLineOnly: true },
  log: { wrap: (s) => `2026-03-04T10:11:12Z INFO auth ok key=${s} user=bob latency=12ms`, singleLineOnly: true },
};

export function buildLeakCorpus(seed = 20260101): LeakSample[] {
  const samples: LeakSample[] = [];
  const gens = makeSecrets(seed);
  for (const [kind, gen] of Object.entries(gens)) {
    for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
      if (ctx.singleLineOnly && MULTI_LINE_KINDS.has(kind)) continue;
      const secret = gen();
      samples.push({ id: `${kind}/${ctxName}`, text: ctx.wrap(secret.text), secrets: secret.values.filter((v) => v.length >= 16) });
    }
  }

  const g = makeSecrets(seed + 1);
  const mk = (k: string) => (g[k] as () => ReturnType<(typeof g)[string]>)();

  // Multi-secret documents.
  {
    const a = mk('aws');
    const b = mk('ghp');
    const c = mk('jwt');
    const d = mk('pemEc');
    samples.push({
      id: 'multi/readme',
      text: `# Setup\n\nAWS: ${a.text}\nGitHub: ${b.text}\nSession: ${c.text}\n\n${d.text}\n\nDone.`,
      secrets: [a.text, b.text, c.text, ...d.values.filter((v) => v.length >= 16)],
    });
  }
  {
    const a = mk('slack');
    const b = mk('skAnt');
    samples.push({
      id: 'multi/same-line',
      text: `tokens ${a.text},${b.text};${a.text}|${b.text}`,
      secrets: [a.text, b.text],
    });
  }
  // Basic-auth URL and bare credential assignments.
  samples.push({
    id: 'url/userinfo',
    text: 'DATABASE_URL=postgres://svc_admin:Tr0ub4dor-and-3@db.internal.invalid:5432/prod',
    secrets: ['Tr0ub4dor-and-3'],
  });
  samples.push({
    id: 'env/password',
    text: 'DB_PASSWORD=correct-horse-battery-staple\nDB_HOST=localhost',
    secrets: ['correct-horse-battery-staple'],
  });
  samples.push({
    id: 'json/quoted-phrase',
    text: '{"client_secret": "spaces are allowed in this one", "client_id": "public-id"}',
    secrets: ['spaces are allowed in this one'],
  });
  samples.push({
    id: 'yaml/api_key',
    text: 'api_key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0\nregion: eu-west-1',
    secrets: ['9f8e7d6c5b4a39281706f5e4d3c2b1a0'],
  });
  samples.push({
    id: 'url/fragment-token',
    text: 'https://app.example.invalid/auth#access_token=ya29.a0AfH6SMBx9d8e7f6a5b4c&token_type=bearer',
    secrets: ['ya29.a0AfH6SMBx9d8e7f6a5b4c'],
  });
  // Evasion.
  {
    const a = mk('aws');
    const zw = a.text.slice(0, 4) + '​' + a.text.slice(4, 12) + '⁠' + a.text.slice(12);
    samples.push({ id: 'evasion/zero-width', text: `key ${zw}`, secrets: [a.text, zw] });
    const wide = a.text.replace(/[A-Z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
    samples.push({ id: 'evasion/fullwidth', text: `key ${wide}`, secrets: [a.text, wide] });
    const b = mk('ghp');
    const soft = b.text.slice(0, 6) + '­' + b.text.slice(6);
    samples.push({ id: 'evasion/soft-hyphen', text: `token ${soft}`, secrets: [b.text, soft] });
  }
  // Blocklist terms (the security test builds the filter with BLOCKLIST).
  samples.push({ id: 'blocklist/plain', text: 'Project Falcon is led by Acme Corp, not Acme Ltd.', secrets: ['Project Falcon', 'Acme Corp', 'Acme'] });
  samples.push({ id: 'blocklist/meta', text: 'The code name is Zed(Internal)+ and nothing else.', secrets: ['Zed(Internal)+'] });
  samples.push({ id: 'blocklist/in-fence', text: '```\n# owner: Acme Corp\nproject = "Project Falcon"\n```', secrets: ['Acme Corp', 'Project Falcon'] });
  return samples;
}
