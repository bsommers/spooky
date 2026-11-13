import { describe, expect, it } from 'vitest';
import { ConfidentialityFilter, normalizeForMatching } from '../../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../../src/filters/pipeline.js';
import { ConfigError } from '../../../src/models/errors.js';
import type { PipelineContext } from '../../../src/models/types.js';
import { makeSecrets } from '../../fixtures/leaks/secrets.js';

const ctx: PipelineContext = { authorId: 'a', personaKey: 'p', stage: 'pre' };
const S = makeSecrets(7);
const secret = (kind: string) => (S[kind] as () => ReturnType<(typeof S)[string]>)();

async function run(text: string, f = new ConfidentialityFilter()) {
  return f.process(text, ctx);
}

describe('ConfidentialityFilter: shape', () => {
  it('is fail-closed and runs pre and post', () => {
    const f = new ConfidentialityFilter();
    expect(f.name).toBe('confidentiality');
    expect(f.onError).toBe('fail-closed');
    expect([...f.stages]).toEqual(['pre', 'post']);
  });

  it('empty string: no error, unchanged', async () => {
    const r = await run('');
    expect(r).toEqual({ content: '', modified: false, metadata: {} });
  });

  it('text with nothing to redact is returned unchanged', async () => {
    const r = await run('The quarterly report is due on Friday. Nothing secret here: 12345.');
    expect(r.modified).toBe(false);
    expect(r.content).toBe('The quarterly report is due on Friday. Nothing secret here: 12345.');
  });
});

describe('ConfidentialityFilter: built-in secret types (CNF-01)', () => {
  it('AWS access key -> [REDACTED:aws_key]', async () => {
    const k = secret('aws');
    const r = await run(`key is ${k.text} ok`);
    expect(r.content).toBe('key is [REDACTED:aws_key] ok');
    expect(r.modified).toBe(true);
  });

  it('ASIA (temporary) AWS keys too', async () => {
    const k = secret('awsTemp');
    expect((await run(k.text)).content).toBe('[REDACTED:aws_key]');
  });

  it('two keys in one string: both redacted (CNF-02)', async () => {
    const a = secret('aws');
    const b = secret('aws');
    const r = await run(`${a.text} and ${b.text}`);
    expect(r.content).toBe('[REDACTED:aws_key] and [REDACTED:aws_key]');
    expect(r.metadata).toEqual({ aws_key: 2 });
  });

  it.each([
    ['ghp', 'github_token'],
    ['ghs', 'github_token'],
    ['githubPat', 'github_token'],
    ['sk', 'api_key'],
    ['skProj', 'api_key'],
    ['skAnt', 'api_key'],
    ['slack', 'slack_token'],
    ['slackUser', 'slack_token'],
    ['jwt', 'jwt'],
  ])('%s -> [REDACTED:%s]', async (kind, type) => {
    const k = secret(kind);
    const r = await run(`token: ${k.text}.`);
    expect(r.content).toContain(`[REDACTED:${type}]`);
    for (const v of k.values) expect(r.content).not.toContain(v);
  });

  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])('"%s abc.def" is redacted whatever the case', async (word) => {
    const r = await run(`Authorization: ${word} abc.def`);
    expect(r.content).toBe('Authorization: [REDACTED:bearer_token]');
  });

  it('a long bearer token is fully removed', async () => {
    const k = secret('bearer');
    const r = await run(`curl -H "Authorization: ${k.text}" https://x.invalid`);
    expect(r.content).not.toContain(k.values[0] as string);
    expect(r.content).toContain('[REDACTED:bearer_token]');
  });

  it.each(['pemRsa', 'pemEc', 'pemOpenssh', 'pemPkcs8', 'pemEncrypted'])(
    'full multi-line PEM block (%s): header through footer removed, body gone',
    async (kind) => {
      const k = secret(kind);
      const r = await run(`before\n${k.text}\nafter`);
      expect(r.content).toBe('before\n[REDACTED:private_key]\nafter');
      for (const v of k.values) expect(r.content).not.toContain(v);
    },
  );

  it('two PEM blocks are each redacted', async () => {
    const a = secret('pemRsa');
    const b = secret('pemEc');
    const r = await run(`${a.text}\n\n${b.text}`);
    expect(r.content).toBe('[REDACTED:private_key]\n\n[REDACTED:private_key]');
    expect(r.metadata).toEqual({ private_key: 2 });
  });

  it('PEM header without footer (truncated) redacts from the header to the end of the text (fail safe)', async () => {
    const k = secret('pemRsa');
    const truncated = k.text.slice(0, k.text.indexOf('-----END'));
    const r = await run(`intro\n${truncated}`);
    expect(r.content).toBe('intro\n[REDACTED:private_key]');
  });

  it('a PEM block inside JSON with escaped newlines is redacted', async () => {
    const k = secret('pemPkcs8');
    const json = JSON.stringify({ private_key: k.text, id: 'abc' });
    const r = await run(json);
    expect(r.content).not.toContain(k.values[0] as string);
    expect(r.content).toContain('"id":"abc"');
  });

  it('does not touch PUBLIC keys or certificates', async () => {
    const t = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----';
    expect((await run(t)).content).toBe(t);
  });
});

describe('ConfidentialityFilter: contextual rules', () => {
  it('redacts the value of credential-looking URL query parameters, keeping the name', async () => {
    const r = await run('https://api.example.com/v1/x?id=7&token=abcdef123456&page=2');
    expect(r.content).toBe('https://api.example.com/v1/x?id=7&token=[REDACTED:url_credential]&page=2');
  });

  it('redacts user:password@ in URLs', async () => {
    const r = await run('postgres://admin:hunter2pass@db.internal:5432/app');
    expect(r.content).toBe('postgres://[REDACTED:url_credential]@db.internal:5432/app');
  });

  it('redacts the value of secret-named assignments in env files, JSON and YAML', async () => {
    expect((await run('DB_PASSWORD=correcthorsebattery\nPORT=8080')).content).toBe(
      'DB_PASSWORD=[REDACTED:secret_assignment]\nPORT=8080',
    );
    expect((await run('{"api_key": "abcd efgh ijkl", "name": "x"}')).content).toBe(
      '{"api_key": "[REDACTED:secret_assignment]", "name": "x"}',
    );
    expect((await run("client_secret: 'qwertyuiop'")).content).toBe("client_secret: '[REDACTED:secret_assignment]'");
  });

  it('does not treat ordinary "tokens" prose or max_tokens as secrets', async () => {
    const t = 'We cap max_tokens: 1500 and count tokens: roughly five per word.';
    expect((await run(t)).content).toBe(t);
  });
});

describe('ConfidentialityFilter: blocklist (CNF-03)', () => {
  it('matches terms with regex metacharacters literally and does not throw', async () => {
    const f = new ConfidentialityFilter({ blocklist: ['Proj(X)+', 'a.c', '[secret'] });
    const r = await run('Working on Proj(X)+ and a.c but not abc; also [secret here', f);
    expect(r.content).toBe('Working on [REDACTED:blocklist] and [REDACTED:blocklist] but not abc; also [REDACTED:blocklist] here');
  });

  it('case-sensitive by default; case-insensitive on request', async () => {
    const off = new ConfidentialityFilter({ blocklist: ['Acme'] });
    expect((await run('acme ACME Acme', off)).content).toBe('acme ACME [REDACTED:blocklist]');
    const on = new ConfidentialityFilter({ blocklist: ['Acme'], caseInsensitive: true });
    expect((await run('acme ACME Acme', on)).content).toBe('[REDACTED:blocklist] [REDACTED:blocklist] [REDACTED:blocklist]');
  });

  it('overlapping terms: longest first, no partial remnant', async () => {
    for (const blocklist of [
      ['Acme', 'Acme Corp'],
      ['Acme Corp', 'Acme'],
    ]) {
      const f = new ConfidentialityFilter({ blocklist });
      expect((await run('Acme Corp signed; Acme left', f)).content).toBe('[REDACTED:blocklist] signed; [REDACTED:blocklist] left');
    }
  });

  it('rejects blank, non-string and duplicate-only-blank entries at construction', () => {
    expect(() => new ConfidentialityFilter({ blocklist: [''] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ blocklist: ['   '] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ blocklist: [5 as unknown as string] })).toThrow(ConfigError);
  });

  it('a term that appears inside an existing placeholder does not re-redact it (idempotent)', async () => {
    const f = new ConfidentialityFilter({ blocklist: ['REDACTED', 'aws_key'] });
    const once = (await run('x [REDACTED:aws_key] y', f)).content;
    expect(once).toBe('x [REDACTED:aws_key] y');
  });
});

describe('ConfidentialityFilter: custom rules (CNF-03)', () => {
  it('a valid custom rule redacts with its own type', async () => {
    const f = new ConfidentialityFilter({ customRules: [{ name: 'employee_id', pattern: 'EMP-\\d{6}' }] });
    const r = await run('ids EMP-123456 and EMP-654321', f);
    expect(r.content).toBe('ids [REDACTED:employee_id] and [REDACTED:employee_id]');
    expect(r.metadata).toEqual({ employee_id: 2 });
  });

  it('is case-insensitive when asked', async () => {
    const f = new ConfidentialityFilter({ customRules: [{ name: 'tag', pattern: 'internal-\\d{1,32}', caseInsensitive: true }] });
    expect((await run('see INTERNAL-42', f)).content).toBe('see [REDACTED:tag]');
  });

  it('an invalid regex throws ConfigError at construction', () => {
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'bad', pattern: '(' }] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'bad', pattern: '[' }] })).toThrow(ConfigError);
  });

  it.each([
    ['nested quantifier (a+)+$', '(a+)+$'],
    ['star of star (a*)*', '(a*)*b'],
    ['quantified alternation (a|aa)+', '(a|aa)+$'],
    ['quantified group with unbounded inner (x.*)+', '(x.*)+y'],
    ['chained bounded quantifiers a{1,500} x4 (CR-01)', 'a{1,500}a{1,500}a{1,500}a{1,500}b'],
    ['chained bounded quantifiers a{0,200} x3 (CR-01)', 'a{0,200}a{0,200}a{0,200}c'],
    ['two large quantifiers (a+a+b)', 'a+a+b'],
    ['one large quantifier next to several small ambiguous ones', 'a+a{1,8}a{1,8}b'],
    ['many small ambiguous quantifiers over budget', 'a{1,16}a{1,16}a{1,16}b'],
    ['backreference', '(a)\\1'],
    ['unbounded + (CR-03)', 'internal-\\d+'],
    ['unbounded {n,}', 'x{2,}y'],
    ['bounded match longer than the window guarantee (CR-03)', 'BEGIN[\\s\\S]{0,2000}END'],
    ['alternation with a branch over the limit', 'ab|c{500}d{20}'],
    ['matches the empty string', 'a?'],
    ['too long', 'a'.repeat(400)],
  ])('rejects a catastrophic or unbounded pattern at construction: %s', (_n, pattern) => {
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'r', pattern }] })).toThrow(ConfigError);
  });

  it.each([
    ['fixed counts never backtrack', '[A-Z0-9]{8}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{12}'],
    ['IPv4-shaped', '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}'],
    ['one large bounded quantifier', 'internal-\\d{1,32}'],
    ['longest possible match exactly at the limit', 'x[a-z]{500}y{10}'],
    ['alternation within the limit', '(?:foo|bar)-\\d{4}'],
    ['astral escape', '\\u{1F600}{2}\\p{L}{1,4}'],
    ['two small variable quantifiers', '[A-Z]{2,4}-\\d{4,8}'],
  ])('still accepts a legitimate rule: %s', (_n, pattern) => {
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'r', pattern }] })).not.toThrow();
  });

  it('every accepted pattern finishes quickly on worst-case inputs (budget is real, not nominal)', async () => {
    const accepted = ['a{1,64}b', 'a{1,3}a{1,3}a{1,3}a{1,3}b', 'a{1,64}a{1,3}b', 'a{1,16}a{1,16}b', 'x?x?x?x?x?x?x?x?b'];
    const inputs = ['a'.repeat(100_000), 'ab'.repeat(50_000), 'x'.repeat(100_000)];
    for (const pattern of accepted) {
      const f = new ConfidentialityFilter({ customRules: [{ name: 'r', pattern }] });
      for (const text of inputs) {
        const t = performance.now();
        await run(text, f);
        expect(performance.now() - t, `${pattern} on ${text.slice(0, 4)}...`).toBeLessThan(2000);
      }
    }
  }, 60_000);

  it('rejects bad names and names colliding with built-in types', () => {
    expect(() => new ConfidentialityFilter({ customRules: [{ name: '', pattern: 'x' }] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'Bad Name!', pattern: 'x' }] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'aws_key', pattern: 'x' }] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'a', pattern: 'x' }, { name: 'a', pattern: 'y' }] })).toThrow(
      ConfigError,
    );
  });

  it('custom-rule matches straddling a window boundary are still found (windows overlap by half)', async () => {
    const f = new ConfidentialityFilter({ customRules: [{ name: 'employee_id', pattern: 'EMP-\\d{6}' }] });
    for (let at = 480; at < 1100; at++) {
      const text = 'x'.repeat(at) + 'EMP-123456' + 'y'.repeat(3000);
      const r = await run(text, f);
      expect(r.content).not.toContain('EMP-123456');
      expect(r.metadata.employee_id).toBeGreaterThanOrEqual(1);
    }
  });

  describe('window edges do not change what a rule means or hide a match (CR-03)', () => {
    const mk = (pattern: string) => new ConfidentialityFilter({ customRules: [{ name: 'r', pattern }] });

    it('a maximum-length (512) match is redacted at every alignment', async () => {
      const f = mk('S[a-z]{510}E');
      const body = 'S' + 'q'.repeat(510) + 'E';
      for (let at = 0; at < 1100; at += 7) {
        const out = (await run('-'.repeat(at) + body + '-'.repeat(1500), f)).content;
        expect(out, `at ${at}`).not.toContain('qqqqq');
        expect(out).toContain('[REDACTED:r]');
      }
    });

    it('^ matches only at the true start of the text, not at each window start', async () => {
      const f = mk('^X\\d{1,3}');
      const text = 'a'.repeat(1024) + 'X5 tail';
      expect((await run(text, f)).content).toBe(text);
      expect((await run('X5 ' + 'a'.repeat(2000), f)).content).toBe('[REDACTED:r] ' + 'a'.repeat(2000));
    });

    it('$ matches only at the true end of the text', async () => {
      const f = mk('\\d{3}$');
      const text = '123' + 'a'.repeat(3000);
      expect((await run(text, f)).content).toBe(text);
      expect((await run('a'.repeat(3000) + '123', f)).content).toBe('a'.repeat(3000) + '[REDACTED:r]');
    });

    it('\\b and look-behind see the real left context at a window start', async () => {
      const f = mk('\\bKEY\\d{4}');
      for (let at = 480; at < 560; at++) {
        const glued = 'a'.repeat(at - 1) + 'x' + 'KEY1234' + 'z'.repeat(1500); // preceded by a word char: no \b
        expect((await run(glued, f)).content, `at ${at}`).toBe(glued);
        const spaced = 'a'.repeat(at - 1) + ' ' + 'KEY1234' + 'z'.repeat(1500);
        expect((await run(spaced, f)).content).toContain('[REDACTED:r]');
      }
      const lb = mk('(?<=id=)\\d{6}');
      for (let at = 440; at < 580; at += 3) {
        const text = 'a'.repeat(at) + 'id=123456' + 'b'.repeat(1500);
        expect((await run(text, lb)).content, `at ${at}`).not.toContain('123456');
      }
    });

    it('a lookahead near the end of a window sees the real text', async () => {
      const f = mk('FOO(?!bar)');
      for (let at = 480; at < 560; at++) {
        const t = 'a'.repeat(at) + 'FOObar' + 'z'.repeat(1500);
        expect((await run(t, f)).content, `at ${at}`).toBe(t);
      }
    });

    it('a 1500-character block that the old BEGIN..END{0,2000} rule leaked is now a construction error', () => {
      expect(() => mk('BEGIN[\\s\\S]{0,2000}END')).toThrow(ConfigError);
    });
  });

  it('a quadratic-prone but accepted pattern still completes quickly on 50k characters (per-rule input cap)', async () => {
    const f = new ConfidentialityFilter({ customRules: [{ name: 'q', pattern: '\\d{1,64}z' }] });
    const start = performance.now();
    await run('1'.repeat(50_000), f);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('ConfidentialityFilter: contextual value boundaries (CR-05)', () => {
  const rx = (t: string) => run(t).then((r) => r.content);
  const longValue = (n: number) => 'Zq7'.repeat(Math.ceil(n / 3)).slice(0, n);

  it.each([300, 1000, 20_000])('a quoted value of %i characters is fully redacted', async (n) => {
    const v = longValue(n);
    expect(await rx(`password: "${v}" next`)).toBe('password: "[REDACTED:secret_assignment]" next');
    expect(await rx(`{"api_key": '${v}'}`)).toBe(`{"api_key": '[REDACTED:secret_assignment]'}`);
  });

  it('an unterminated quote redacts to the end of the line instead of leaking', async () => {
    expect(await rx('secret = "abcdefgh\nnext line')).toBe('secret = "[REDACTED:secret_assignment]\nnext line');
  });

  it('a value on the line after the separator is redacted (pretty-printed JSON, YAML block style)', async () => {
    expect(await rx('{"password":\n  "abcdefgh"}')).toBe('{"password":\n  "[REDACTED:secret_assignment]"}');
    expect(await rx('password:\n  hunter2hunter2')).toBe('password:\n  [REDACTED:secret_assignment]');
    expect(await rx('{\r\n"token":\r\n\t"abcdefgh"\r\n}')).toBe('{\r\n"token":\r\n\t"[REDACTED:secret_assignment]"\r\n}');
  });

  it.each([
    ['postgres://user:p@ss@host/db', 'postgres://[REDACTED:url_credential]@host/db'],
    ['postgres://user:p@ss@w0rd@host:5432/db?x=1', 'postgres://[REDACTED:url_credential]@host:5432/db?x=1'],
    ['redis://default:pa/ss@cache.internal:6379', 'redis://[REDACTED:url_credential]@cache.internal:6379'],
    ['https://u:pw@host', 'https://[REDACTED:url_credential]@host'],
    ['ftp://admin:' + 'x'.repeat(600) + '@ftp.example.invalid/pub', 'ftp://[REDACTED:url_credential]@ftp.example.invalid/pub'],
  ])('URL userinfo keeps nothing of the password: %s', async (input, expected) => {
    expect(await rx(input)).toBe(expected);
  });

  it('URLs without credentials are left alone', async () => {
    for (const u of ['https://example.com/a?b=c', 'https://example.com:8080/path', 'mailto://bob@example.com', 'see https://x.test and bob@x.test']) {
      expect(await rx(u), u).toBe(u);
    }
  });

  it('a bare value containing , or ; is redacted whole', async () => {
    expect(await rx('password=abc,def;ghi done')).toBe('password=[REDACTED:secret_assignment] done');
  });

  it('the wider boundaries stay linear on adversarial input', async () => {
    const inputs = [
      'http://u:' + 'a@'.repeat(50_000),
      'http://u:' + 'a'.repeat(200_000),
      'http://u:a@h'.repeat(20_000),
      'password: "'.repeat(20_000),
      'password:\n'.repeat(20_000),
      'token=' + ',;'.repeat(100_000),
      'x://a:'.repeat(30_000),
    ];
    for (const text of inputs) {
      const t = performance.now();
      await run(text);
      expect(performance.now() - t, text.slice(0, 20)).toBeLessThan(3000);
    }
  }, 60_000);

  it('a bare value still stops at & (query separator) and whitespace', async () => {
    expect(await rx('password=abcd&user=bob')).toBe('password=[REDACTED:secret_assignment]&user=bob');
  });
});

describe('ConfidentialityFilter: provider formats and auth headers (CR-06)', () => {
  it.each([
    ['stripeLive', 'stripe_key'],
    ['stripeRestricted', 'stripe_key'],
    ['google', 'google_api_key'],
    ['gitlab', 'gitlab_token'],
    ['npm', 'npm_token'],
    ['huggingface', 'hf_token'],
    ['sendgrid', 'sendgrid_key'],
  ])('%s is redacted by shape with no keyword in front, labelled %s', async (kind, type) => {
    const k = secret(kind);
    expect(k.type).toBe(type);
    for (const wrap of [(x: string) => x, (x: string) => `here: ${x}.`, (x: string) => `"${x}"`, (x: string) => `value=${x}&n=1`]) {
      const r = await run(wrap(k.text));
      expect(r.content).not.toContain(k.text.slice(8));
      expect(r.metadata[type]).toBe(1);
    }
  });

  it('short provider prefixes need a left boundary: ordinary words are not secrets', async () => {
    for (const t of ['task_live_tester_account_name', 'xhf_' + 'a'.repeat(40), 'mask_live_' + 'a'.repeat(30)]) {
      expect((await run(t)).content, t).toBe(t);
    }
  });

  it.each([
    ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', 'Authorization: [REDACTED:auth_header]'],
    ['authorization: token abcdef0123456789', 'authorization: [REDACTED:auth_header]'],
    ['"Authorization":"Basic dXNlcjpwYXNzd29yZDEyMw=="', '"Authorization":"[REDACTED:auth_header]"'],
    ['Authorization = Digest username="bob", realm="x", response="deadbeefdeadbeef"', 'Authorization = [REDACTED:auth_header]'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==" https://x.invalid', 'curl -H "Authorization: [REDACTED:auth_header]" https://x.invalid'],
  ])('auth header credentials are redacted: %s', async (input, expected) => {
    expect((await run(input)).content).toBe(expected);
  });

  it.each([
    ['my password is hunter2', 'my password is [REDACTED:secret_assignment]'],
    ['The passphrase is "correct horse battery"', 'The passphrase is "[REDACTED:secret_assignment]"'],
    ['pass=hunter22', 'pass=[REDACTED:secret_assignment]'],
    ['pass: s3cr3tvalue', 'pass: [REDACTED:secret_assignment]'],
    ['PASSPHRASE=abc123xyz', 'PASSPHRASE=[REDACTED:secret_assignment]'],
    ['passcode: 482913', 'passcode: [REDACTED:secret_assignment]'],
  ])('natural-language and short password forms: %s', async (input, expected) => {
    expect((await run(input)).content).toBe(expected);
  });

  it('pass / password words without a separator, and passport-like words, are left alone', async () => {
    for (const t of ['you shall not pass', 'passport: valid', 'the password was reset', 'passenger: Alice Smith']) {
      expect((await run(t)).content, t).toBe(t);
    }
  });
});

describe('ConfidentialityFilter: normalization (unicode evasion)', () => {
  it('zero-width characters inside a key are stripped, then the key is redacted', async () => {
    const k = secret('aws').text;
    const evaded = k.slice(0, 2) + '​' + k.slice(2, 10) + '‍﻿' + k.slice(10);
    const r = await run(`k=${evaded}`);
    expect(r.content).toBe('k=[REDACTED:aws_key]');
  });

  it('full-width homoglyph letters are NFKC-normalized, then redacted', async () => {
    const k = secret('aws').text;
    const wide = k.replace(/[A-Z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect(wide).not.toBe(k);
    expect((await run(wide)).content).toBe('[REDACTED:aws_key]');
  });

  it('text with no secret is returned byte for byte: no folding, no stripping (CR-04)', async () => {
    const benign = [
      '…', '™', '½', 'ﬁle', 'a\u00a0b', // compatibility characters and NBSP
      '❤\ufe0f', '👨\u200d👩\u200d👧', // emoji presentation selector and ZWJ sequence
      'سلام\u200cدنیا', // Persian ZWNJ is orthographically required
      '\uff21\uff22\uff23 full-width', 'e\u0301 combining', '한국어 \u1112\u1161\u11ab', 'ＫＥＹ ０１',
    ];
    for (const text of benign) {
      const r = await run(text);
      expect(r.content, JSON.stringify(text)).toBe(text);
      expect(r.modified).toBe(false);
    }
  });

  it('only the secret is replaced; non-secret text around and between secrets keeps its characters (CR-04)', async () => {
    const k = secret('aws').text;
    const evaded = k.slice(0, 4) + '\u200b' + k.slice(4); // ZWSP inside the key is part of the redacted span
    const r = await run(`ﬁle … ${evaded} ❤\ufe0f سلام\u200cدنیا ${k} ½`);
    expect(r.content).toBe('ﬁle … [REDACTED:aws_key] ❤\ufe0f سلام\u200cدنیا [REDACTED:aws_key] ½');
    expect(r.modified).toBe(true);
  });

  it('a full-width secret is detected on the normalized text and the original characters are replaced (CR-04)', async () => {
    const k = secret('aws').text;
    const wide = k.replace(/[A-Z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expect((await run(`ＫＥＹ: ${wide} ﬁne`)).content).toBe('ＫＥＹ: [REDACTED:aws_key] ﬁne');
    const lig = '…' + secret('ghp').text + '…ﬁ';
    expect((await run(lig)).content).toBe('…[REDACTED:github_token]…ﬁ');
  });

  it('a secret right next to a ligature or emoji does not swallow more than the segment it touches (CR-04)', async () => {
    const k = secret('aws').text;
    expect((await run(`😀${k}😀`)).content).toBe('😀[REDACTED:aws_key]😀');
    expect((await run(`é${k}é`)).content).toBe('é[REDACTED:aws_key]é');
  });

  it('segment-wise normalization agrees with whole-string NFKC on random unicode soup (detection is not weakened)', () => {
    const atoms = ['a', 'Z', '7', ' ', 'e', '\u0301', '\u0308', '\u200b', '\ufe0f', '\u200d', 'ﬁ', '…', 'Ａ', '１', '\u1112', '\u1161', '\u11ab', '한', '😀', 'é', '\u00ad', '\u2160', '\u0e33', 'ǆ', '\u0f73'];
    const ref = (t: string) => t.replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu, '');
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let n = 0; n < 3000; n++) {
      let t = '';
      for (let k = rnd() * 12; k > 0; k--) t += atoms[Math.floor(rnd() * atoms.length)];
      expect(normalizeForMatching(t), JSON.stringify(t)).toBe(ref(ref(t).normalize('NFKC')));
    }
  });

  it('zero-width characters inside a blocklist term are also seen through', async () => {
    const f = new ConfidentialityFilter({ blocklist: ['Project Falcon'] });
    expect((await run('about Pro​ject Fal​con today', f)).content).toBe('about [REDACTED:blocklist] today');
  });
});

describe('ConfidentialityFilter: idempotence (CNF-05) and statelessness', () => {
  it('redact(redact(x)) === redact(x) for every secret kind in assorted contexts', async () => {
    const f = new ConfidentialityFilter({ blocklist: ['Acme Corp'], customRules: [{ name: 'employee_id', pattern: 'EMP-\\d{6}' }] });
    for (const kind of Object.keys(S)) {
      const k = secret(kind);
      for (const wrap of [(s: string) => s, (s: string) => `x ${s} y`, (s: string) => `{"v":"${s}"}`, (s: string) => `PASSWORD=${s}`, (s: string) => `?token=${s}`]) {
        const once = (await run(wrap(k.text) + ' Acme Corp EMP-123456', f)).content;
        const twice = (await run(once, f)).content;
        expect(twice).toBe(once);
      }
    }
  });

  it('the same instance gives identical results on repeated calls (no lastIndex state)', async () => {
    const f = new ConfidentialityFilter({ blocklist: ['Acme'] });
    const text = `${secret('aws').text} ${secret('ghp').text} Acme`;
    const first = await run(text, f);
    for (let i = 0; i < 5; i++) expect(await run(text, f)).toEqual(first);
  });

  it('adjacent placeholders under a contextual rule are left alone (regression: torture seed found a relabel on pass 2)', async () => {
    const t = 'token: [REDACTED:secret_assignment][REDACTED:url_credential] Utilize';
    expect((await run(t)).content).toBe(t);
  });

  it('replacing a secret with a placeholder can move a contextual value boundary; the result is still a fixed point', async () => {
    const pem = secret('pemPkcs8').text;
    const t = `token: ${pem}\u0001it's worth noting`;
    const once = (await run(t)).content;
    expect(once).not.toContain('BEGIN');
    expect((await run(once)).content).toBe(once);
  });

  it('already-present placeholders are left exactly as they are', async () => {
    const t = 'a [REDACTED:aws_key] b [REDACTED:custom_thing] c';
    expect((await run(t)).content).toBe(t);
  });
});

describe('ConfidentialityFilter: metadata and trace never carry matched values (CNF-04)', () => {
  it('metadata is per-type counts only', async () => {
    const r = await run(`${secret('aws').text} ${secret('aws').text} ${secret('jwt').text}`);
    expect(r.metadata).toEqual({ aws_key: 2, jwt: 1 });
  });

  it('no matched value appears anywhere in the pipeline trace', async () => {
    const secrets = [secret('aws'), secret('ghp'), secret('pemRsa'), secret('bearer'), secret('skAnt')];
    const text = secrets.map((s) => s.text).join('\n');
    const out = await new FilterPipeline().use(new ConfidentialityFilter()).run(text, ctx);
    const dump = JSON.stringify(out.trace);
    for (const s of secrets) for (const v of s.values) expect(dump).not.toContain(v);
    expect(out.trace[0]?.modified).toBe(true);
  });

  it('a throwing internal error would surface as FilterFailedError through the pipeline (fail-closed)', async () => {
    const f = new ConfidentialityFilter();
    const broken = { ...f, name: 'confidentiality', stages: f.stages, onError: f.onError, process: () => Promise.reject(new Error('x')) };
    await expect(new FilterPipeline().use(broken).run('abc', ctx)).rejects.toMatchObject({ code: 'FILTER_FAILED', filter: 'confidentiality' });
  });
});

describe('ConfidentialityFilter: size and performance', () => {
  it('1MB of ordinary text with a few secrets completes in under 1s', async () => {
    const para = 'The committee reviewed the proposal and agreed to meet again next week. '.repeat(10);
    let text = '';
    while (text.length < 1_000_000) text += para + secret('aws').text + ' ';
    const start = performance.now();
    const r = await run(text);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(r.metadata.aws_key).toBeGreaterThan(100);
    expect(r.content).not.toMatch(/AKIA[A-Z0-9]{16}/);
  });

  it.each(['eyJ', 'sk-', 'AKIA', 'Bearer ', '-----BEGIN PRIVATE KEY-----', 'password=', '?token=', 'a-', '://', 'gh' + 'p_'])(
    'adversarial 1MB repetition of %j completes in under 2s',
    async (unit) => {
      const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const start = performance.now();
      await run(text);
      expect(performance.now() - start).toBeLessThan(2000);
    },
    10_000,
  );
});
