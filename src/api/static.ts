// Static mount for the web UI (Phase 10): serves the built `ui/dist` from the API server, one process and one origin
// (no CORS). It plugs into `startApiServer({ staticHandler })`, which runs BEFORE the token check, so this serves public
// assets only: the bundled app, fonts, icons and licenses. There is no secret in them; the API behind `/api/*` stays
// token-protected and the UI asks for the token itself, keeping it in memory.
//
//   - GET/HEAD only. A file that is not under the root, a dotfile, or any path with `..`, a NUL, a backslash or an encoded
//     slash in a segment is a 404 (never "forbidden": the response does not confirm that a path exists elsewhere). The
//     resolved real path must stay inside the real root, so a symlink cannot lead out of it.
//   - SPA fallback: a path with no file extension that is not part of the protected namespace answers with index.html, so
//     a reloaded deep link works. `/api`, `/api/...`, `/openapi.json` and `/mcp` never fall back: they stay 404 here.
//   - Content-Security-Policy: scripts, styles, fonts and images from this origin only; no inline script or style, no
//     frames, no `<base>`, no forms posting elsewhere. The build output is checked for CSP-compatibility by a test.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySecurityHeaders, MCP_PATH, OPENAPI_PATH } from './server.js';
import type { StaticHandler } from './server.js';

/**
 * React Aria's iOS scroll lock inserts one fixed inline `<style>` while a modal is open. Allowing exactly that text by hash
 * keeps `style-src` free of 'unsafe-inline'. ui/tests/build/csp-compat.test.ts recomputes the hash from the installed
 * react-aria source, so a library upgrade that changes the text fails a test instead of a phone.
 */
export const REACT_ARIA_SCROLL_LOCK_STYLE_HASH = "'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='";

export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  `style-src 'self' ${REACT_ARIA_SCROLL_LOCK_STYLE_HASH}`,
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const isProtectedPath = (p: string): boolean => p === '/api' || p.startsWith('/api/') || p === OPENAPI_PATH || p === MCP_PATH;

/** The decoded path segments, or undefined when any segment could name something outside the root. */
function safeSegments(pathname: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of pathname.split('/').slice(1)) {
    if (raw === '') continue; // a trailing slash or "//" inside the path
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (seg === '..' || seg.startsWith('.') || /[\\/\0]/.test(seg)) return undefined;
    out.push(seg);
  }
  return out;
}

export interface StaticHandlerOptions {
  /** Directory holding the built UI (must contain index.html). */
  root: string;
}

/**
 * True when `dir` holds a built UI: an `index.html` that is a regular file AND whose real path stays inside the real `dir`
 * (a symlinked index.html pointing elsewhere is not a build).
 */
export async function hasBuiltUi(dir: string): Promise<boolean> {
  try {
    const realDir = await realpath(dir);
    const prefix = realDir.endsWith(sep) ? realDir : realDir + sep;
    const index = await realpath(join(realDir, 'index.html'));
    if (!index.startsWith(prefix)) return false;
    return (await stat(index)).isFile();
  } catch {
    return false;
  }
}

/** `ui/dist` next to the package (works from `src/` under vitest and from `dist/src/` once compiled), or undefined. */
export async function defaultUiDir(): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [join('..', '..', 'ui', 'dist'), join('..', '..', '..', 'ui', 'dist')]) {
    const dir = resolve(here, rel);
    if (await hasBuiltUi(dir)) return dir;
  }
  return undefined;
}

export async function createStaticHandler(options: StaticHandlerOptions): Promise<StaticHandler> {
  const root = await realpath(resolve(options.root));
  if (!(await hasBuiltUi(root))) throw new Error('the UI directory has no index.html (build it with: npm run ui:build)');
  const rootPrefix = root.endsWith(sep) ? root : root + sep;

  /** The real file for `segments` inside the root, or undefined. */
  async function locate(segments: readonly string[]): Promise<{ file: string; size: number } | undefined> {
    const candidate = resolve(root, ...segments);
    if (candidate !== root && !candidate.startsWith(rootPrefix)) return undefined;
    try {
      const real = await realpath(candidate);
      if (real !== root && !real.startsWith(rootPrefix)) return undefined;
      let st = await stat(real);
      let file = real;
      if (st.isDirectory()) {
        // The implicit index may itself be a symlink: re-resolve and re-check containment before reading it.
        file = await realpath(join(real, 'index.html'));
        if (!file.startsWith(rootPrefix)) return undefined;
        st = await stat(file);
      }
      return st.isFile() ? { file, size: st.size } : undefined;
    } catch {
      return undefined;
    }
  }

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return false;
    if (isProtectedPath(url.pathname)) return false;
    const segments = safeSegments(url.pathname);
    if (segments === undefined) return false;

    let found = await locate(segments);
    if (found === undefined && extname(url.pathname) === '') found = await locate([]); // SPA fallback
    if (found === undefined) return false;

    const ext = extname(found.file).toLowerCase();
    applySecurityHeaders(res, UI_CSP);
    // Hashed bundle files never change under the same name; everything else is re-checked. Judge the REQUESTED name (a symlink
    // must not borrow a hashed target name) and use Vite's hash shape: exactly eight base64url characters before the extension.
    if (segments[0] === 'assets' && /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(segments[segments.length - 1] ?? '')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(found.size));
    res.statusCode = 200;
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise<void>((done) => {
      const stream = createReadStream(found.file);
      stream.on('error', () => {
        res.destroy();
        done();
      });
      res.on('close', () => {
        stream.destroy();
        done();
      });
      stream.pipe(res);
    });
    return true;
  };
}
