// Model output, corpus text and persona text are untrusted, so nothing in the UI source may turn a string into markup or
// code. This is the equivalent of the eslint rules `react/no-danger` and `no-restricted-syntax` (the plan's list), done
// on the TypeScript syntax tree so it needs no extra dependency: a regex over text would be fooled by comments, strings
// and spacing. The checker is tested on bad snippets first, so a clean run means the rules work.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { UI_ROOT } from '../helpers/themes';

const SRC = join(UI_ROOT, 'src');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

const BANNED_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'insertAdjacentHTML', 'createContextualFragment', 'insertAdjacentElement', 'execCommand']);
const BANNED_CALLS = new Set(['eval', 'Function', 'execScript']);
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formAction', 'xlinkHref', 'data', 'poster']);

export function violations(code: string, opts: { strictUrls: boolean }): string[] {
  const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const at = (n: ts.Node, what: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    out.push(`${line + 1}: ${what}`);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n)) {
      const name = n.name.getText(sf);
      if (name === 'dangerouslySetInnerHTML') at(n, 'dangerouslySetInnerHTML');
      if (opts.strictUrls && URL_ATTRS.has(name) && n.initializer !== undefined && !ts.isStringLiteral(n.initializer)) {
        const inner = ts.isJsxExpression(n.initializer) ? n.initializer.expression : undefined;
        // a template of a fixed prefix and a route constant (`#${r.path}`) is the shell's own navigation; anything else is data
        if (!(inner !== undefined && ts.isTemplateExpression(inner) && inner.head.text.startsWith('#'))) at(n, `${name} from an expression`);
      }
    }
    if (ts.isPropertyAccessExpression(n) && BANNED_PROPS.has(n.name.text)) at(n, `.${n.name.text}`);
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && BANNED_PROPS.has(n.argumentExpression.text)) at(n, `["${n.argumentExpression.text}"]`);
    if (ts.isIdentifier(n) && n.text === 'innerHTML') at(n, 'innerHTML');
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'document' && (n.name.text === 'write' || n.name.text === 'writeln')) at(n, `document.${n.name.text}`);
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (BANNED_CALLS.has(name)) at(n, `${name}()`);
      if (TIMERS.has(name) && n.arguments?.[0] !== undefined && ts.isStringLiteralLike(n.arguments[0])) at(n, `${name}(string)`);
      if (name === 'DOMParser' || name === 'parseFromString') at(n, name);
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /^(?:react-markdown|marked|markdown-it|remark|rehype|dompurify|sanitize-html|showdown|snarkdown)/.test(n.moduleSpecifier.text)) at(n, `import ${n.moduleSpecifier.text}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('the checker (so clean means something)', () => {
  const strict = { strictUrls: true };
  it.each([
    ['dangerouslySetInnerHTML', 'const a = <div dangerouslySetInnerHTML={{ __html: x }} />;'],
    ['innerHTML assignment', 'el.innerHTML = x;'],
    ['outerHTML', 'el.outerHTML = x;'],
    ['bracket access', 'el["innerHTML"] = x;'],
    ['insertAdjacentHTML', 'el.insertAdjacentHTML("beforeend", x);'],
    ['document.write', 'document.write(x);'],
    ['eval', 'eval(x);'],
    ['new Function', 'const f = new Function("return 1");'],
    ['Function()', 'Function("return 1")();'],
    ['setTimeout with a string', 'setTimeout("alert(1)", 10);'],
    ['srcdoc', 'iframe.srcdoc = x;'],
    ['DOMParser', 'new DOMParser().parseFromString(x, "text/html");'],
    ['a markdown renderer', 'import Markdown from "react-markdown";'],
    ['a link built from data', 'const a = <a href={model.url}>x</a>;'],
    ['an image built from data', 'const a = <img src={text} />;'],
  ])('flags %s', (_n, code) => {
    expect(violations(code, strict).length, code).toBeGreaterThan(0);
  });

  it('does not flag comments, strings that mention the word, or static links and the shell\'s own #route links', () => {
    const ok = [
      '// never use dangerouslySetInnerHTML or innerHTML',
      'const s = "innerHTML is banned";',
      'const a = <a href="#/authors">Ingest</a>;',
      'const b = <Link href={`#${r.path}`}>x</Link>;',
      'setTimeout(() => setDone(false), 2000);',
    ].join('\n');
    expect(violations(ok, strict)).toEqual([]);
  });
});

describe('ui/src', () => {
  const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));

  it('has no way to turn text into markup or code (dangerouslySetInnerHTML, innerHTML, eval, ...)', () => {
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(violations(readFileSync(f, 'utf8'), { strictUrls: false }), relative(SRC, f)).toEqual([]);
  });

  it('screens and shared components never take a link or an image address from data', () => {
    for (const f of files.filter((p) => /[\\/](screens|components)[\\/]/.test(p))) {
      expect(violations(readFileSync(f, 'utf8'), { strictUrls: true }), relative(SRC, f)).toEqual([]);
    }
  });

  it('depends on no markdown or HTML sanitizer library', () => {
    const pkg = JSON.parse(readFileSync(join(UI_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => /markdown|marked|remark|rehype|dompurify|sanitize|showdown|snarkdown/.test(d))).toEqual([]);
  });
});
