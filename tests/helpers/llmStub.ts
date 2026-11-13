// Local HTTP stub for provider adapter tests. Records every request (headers + parsed JSON body) and answers from a
// per-test handler. No network beyond 127.0.0.1.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
export type StubHandler = (req: RecordedRequest, res: ServerResponse, n: number) => void;

export interface Stub {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  setHandler(h: StubHandler): void;
  close(): Promise<void>;
}

export async function startStub(initial: StubHandler): Promise<Stub> {
  let handler = initial;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(rec);
      handler(rec, res, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (h) => void (handler = h),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

export const openaiOk = (content: unknown) => ({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
export const anthropicOk = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });

/** A port that was open a moment ago and is now closed: connections to it are refused. */
export async function closedOrigin(): Promise<string> {
  const s = await startStub(() => {});
  const origin = s.origin;
  await s.close();
  return origin;
}
