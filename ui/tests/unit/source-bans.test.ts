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
/** Attribute names that setAttribute must not receive from data: the URL ones above (any case), the markup one, and event handlers. */
const isUrlAttrName = (name: string): boolean => {
  const n = name.toLowerCase();
  return [...URL_ATTRS].some((a) => a.toLowerCase() === n) || n === 'srcdoc' || n === 'formaction' || n === 'xlink:href' || n.startsWith('on');
};
/** Elements whose attributes can load or navigate: a spread of unknown props onto one of them could carry a URL. */
const URL_TAGS = new Set(['a', 'img', 'iframe', 'form', 'object', 'embed', 'source', 'video', 'audio', 'area', 'link', 'base', 'input', 'button', 'track', 'use', 'image']);
/** Markdown, HTML parsing and sanitizing libraries: text from the model must never go through one. */
export const MARKUP_PACKAGE = /^(?:react-markdown|marked|markdown-it|markdown-to-jsx|remark|rehype|unified|micromark|mdast|hast|mdx|@mdx-js|html-react-parser|react-html-parser|htmr|interweave|dompurify|isomorphic-dompurify|sanitize-html|showdown|snarkdown|parse5|htmlparser2|cheerio)/;
const isLocation = (e: ts.Expression, sf: ts.SourceFile): boolean => /(?:^|\.)location$/.test(e.getText(sf));

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
        // exactly `#${path}` or `#${x.path}` (a route constant from ROUTES) is the shell's own navigation; anything else is data
        const isRoute =
          inner !== undefined &&
          ts.isTemplateExpression(inner) &&
          inner.head.text === '#' &&
          inner.templateSpans.length === 1 &&
          inner.templateSpans[0]!.literal.text === '' &&
          ((ts.isIdentifier(inner.templateSpans[0]!.expression) && inner.templateSpans[0]!.expression.text === 'path') ||
            (ts.isPropertyAccessExpression(inner.templateSpans[0]!.expression) && inner.templateSpans[0]!.expression.name.text === 'path'));
        if (!isRoute) at(n, `${name} from an expression`);
      }
    }
    if (opts.strictUrls && ts.isJsxSpreadAttribute(n)) {
      const el = n.parent.parent;
      if ((ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el)) && URL_TAGS.has(el.tagName.getText(sf))) at(n, `spread props onto <${el.tagName.getText(sf)}>`);
    }
    // navigation sinks: location.href = x, location = x, location.assign(x), location.replace(x), window.open(x)
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = n.left;
      if (ts.isPropertyAccessExpression(l) && l.name.text === 'href' && isLocation(l.expression, sf)) at(n, 'location.href = ...');
      if (isLocation(l, sf)) at(n, 'location = ...');
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const callee = n.expression;
      if ((callee.name.text === 'assign' || callee.name.text === 'replace') && isLocation(callee.expression, sf)) at(n, `location.${callee.name.text}()`);
      if (callee.name.text === 'open' && /^(?:window|self|globalThis|top|parent)$/.test(callee.expression.getText(sf))) at(n, 'window.open()');
      if (callee.name.text === 'setAttribute' || callee.name.text === 'setAttributeNS') {
        const arg = n.arguments[callee.name.text === 'setAttribute' ? 0 : 1];
        if (arg === undefined || !ts.isStringLiteralLike(arg) || isUrlAttrName(arg.text)) at(n, `${callee.name.text}(${arg?.getText(sf) ?? ''})`);
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
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && MARKUP_PACKAGE.test(n.moduleSpecifier.text)) at(n, `import ${n.moduleSpecifier.text}`);
    // import('react-markdown') and require('marked'); a computed specifier cannot be proven safe
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const arg = n.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg) && MARKUP_PACKAGE.test(arg.text)) at(n, `import(${arg.text})`);
    }
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
    ['location.href assigned', 'location.href = x;'],
    ['window.location.href assigned', 'window.location.href = model.url;'],
    ['location assigned', 'window.location = x;'],
    ['location.assign', 'location.assign(x);'],
    ['window.location.replace', 'window.location.replace(x);'],
    ['window.open', 'window.open(x);'],
    ['setAttribute href', 'el.setAttribute("href", x);'],
    ['setAttribute with a computed name', 'el.setAttribute(name, x);'],
    ['setAttribute for an event handler', 'el.setAttribute("onclick", x);'],
    ['setAttribute src in odd case', 'el.setAttribute("SrcDoc", x);'],
    ['spread props onto a link', 'const a = <a {...p}>x</a>;'],
    ['spread props onto an image', 'const a = <img {...p} />;'],
    ['a dynamic markdown import', 'const M = await import("react-markdown");'],
    ['require of a sanitizer', 'const d = require("dompurify");'],
    ['micromark', 'import { micromark } from "micromark";'],
    ['mdx', 'import { evaluate } from "@mdx-js/mdx";'],
    ['html-react-parser', 'import parse from "html-react-parser";'],
    ['a # link carrying data', 'const a = <a href={`#${model.x}`}>x</a>;'],
    ['a # link with a data tail', 'const a = <a href={`#${r.path}${model.x}`}>x</a>;'],
  ])('flags %s', (_n, code) => {
    expect(violations(code, strict).length, code).toBeGreaterThan(0);
  });

  it('does not flag comments, strings that mention the word, or static links and the shell\'s own #route links', () => {
    const ok = [
      '// never use dangerouslySetInnerHTML or innerHTML',
      'const s = "innerHTML is banned";',
      'const a = <a href="#/authors">Ingest</a>;',
      'const b = <Link href={`#${r.path}`}>x</Link>;',
      'const c = <a href={`#${path}`}>x</a>;',
      'const route = parseHash(window.location.hash);',
      'root.setAttribute("data-theme", id);',
      'const d = <Input {...props} />;',
      'const e = await import("./ScoreScreen");',
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
    expect(Object.keys(pkg.dependencies).filter((d) => MARKUP_PACKAGE.test(d) || /markdown|mdx|sanitize/.test(d))).toEqual([]);
  });
});
