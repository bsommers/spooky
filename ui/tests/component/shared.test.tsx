// The shared pieces every feature screen is built from: error banner (typed codes), auth gate, capability gating,
// plain-text rendering, bars, the live-region announcer and the load hook.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import { CapabilitiesProvider, useCapabilities } from '../../src/api/capabilities';
import { ApiProvider } from '../../src/api/context';
import { AnnouncerProvider, LiveRegion, useAnnounce } from '../../src/components/Announcer';
import { AuthGate } from '../../src/components/AuthGate';
import { Bar, BarTable, fmt } from '../../src/components/Bars';
import { ErrorBanner } from '../../src/components/ErrorBanner';
import { ERROR_COPY } from '../../src/components/errors';
import { PlainText } from '../../src/components/PlainText';
import { Indicators, TraceTable, countsFromTrace } from '../../src/components/Trace';
import { useLoad } from '../../src/components/useLoad';
import { CAPS_FULL, CAPS_NO_PHASE8, ERR, HOSTILE, TRACE } from '../helpers/fixtures';
import { fakeClient, jsonResponse, mockClient } from '../helpers/app';
import { runAxe, describeViolations } from '../helpers/axe';

const KNOWN_CODES = [
  'UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'OVERLOADED', 'REQUEST_TIMEOUT', 'INPUT_TOO_LARGE', 'USAGE', 'UNKNOWN_PERSONA', 'UNKNOWN_AUTHOR',
  'LLM_FAILED', 'FILTER_FAILED', 'DETECTORS_FAILED', 'PROFILE_INVALID', 'STORE_CORRUPT', 'STATE_LOCKED', 'CONFIG_INVALID', 'NETWORK', 'BAD_RESPONSE', 'NOT_FOUND', 'INTERNAL',
];

describe('ErrorBanner', () => {
  it.each(KNOWN_CODES)('%s has its own wording, shows the server message and the code as text, and is an alert', (code) => {
    render(<ErrorBanner error={new ApiError(400, code, 'the server said this')} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-code', code);
    expect(alert).toHaveTextContent('the server said this');
    expect(alert).toHaveTextContent(code);
    expect(alert).toHaveTextContent(ERROR_COPY[code]!.title);
  });

  it('an unknown code still reads as a failure; Retry-After is shown; retry is offered only when asked for', async () => {
    const user = userEvent.setup();
    let retried = 0;
    const { rerender } = render(<ErrorBanner error={new ApiError(429, 'RATE_LIMITED', 'slow', 30)} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Try again in 30 seconds.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(<ErrorBanner error={new ApiError(500, 'SOMETHING_NEW', 'm')} onRetry={() => retried++} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The request failed.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retried).toBe(1);
  });

  it('renders hostile server text literally', () => {
    const { container } = render(<ErrorBanner error={new ApiError(500, 'INTERNAL', HOSTILE.img + HOSTILE.script)} />);
    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('<img src=x onerror="window.__pwned=1">');
  });
});

describe('PlainText', () => {
  it('shows markup, script tags and javascript: links as literal text, creates no element and no link', () => {
    for (const hostile of Object.values(HOSTILE)) {
      const { container, unmount } = render(<PlainText text={hostile} label="Generated text" />);
      const region = screen.getByRole('region', { name: 'Generated text' });
      expect(region.textContent).toBe(hostile);
      expect(region.children.length).toBe(0);
      expect(container.querySelector('a, img, script, b')).toBeNull();
      unmount();
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('capability gating and the auth gate', () => {
  function Probe() {
    const { state, has } = useCapabilities();
    return (
      <p>
        {state.kind} score={String(has('score'))} humanize={String(has('humanize'))} generate={String(has('generate'))}
      </p>
    );
  }
  const wrap = (client = mockClient(), child = <Probe />) =>
    render(
      <ApiProvider client={client}>
        <CapabilitiesProvider>{child}</CapabilitiesProvider>
      </ApiProvider>,
    );

  it('has() is false while loading, then true only for operations the server lists', async () => {
    wrap();
    expect(screen.getByText(/^loading score=false/)).toBeInTheDocument();
    expect(await screen.findByText('ok score=true humanize=true generate=true')).toBeInTheDocument();
  });

  it('a server without Phase 8 reports score and humanize as absent', async () => {
    wrap(mockClient({ 'GET /api/capabilities': () => ({ status: 200, body: CAPS_NO_PHASE8 }) }));
    expect(await screen.findByText('ok score=false humanize=false generate=true')).toBeInTheDocument();
  });

  it('overlapping reloads: the newest answer is kept even when an older request answers after it', async () => {
    const releases: Array<(r: Response) => void> = [];
    const client = fakeClient(() => new Promise<Response>((r) => releases.push(r)));
    let reload: (wrong?: boolean) => Promise<void> = async () => undefined;
    function Grab() {
      reload = useCapabilities().reload;
      return <Probe />;
    }
    wrap(client, <Grab />);
    await waitFor(() => expect(releases).toHaveLength(1));
    act(() => void reload());
    await waitFor(() => expect(releases).toHaveLength(2));
    await act(async () => releases[1]!(jsonResponse(200, CAPS_FULL)));
    expect(await screen.findByText(/^ok /)).toBeInTheDocument();
    await act(async () => releases[0]!(jsonResponse(503, ERR('OVERLOADED', 'late and stale'))));
    expect(screen.getByText(/^ok /)).toBeInTheDocument(); // the older failure did not overwrite it
  });

  it('AuthGate: loading status, then children; on 401 the token form; a right token opens the gate; the token is never stored', async () => {
    const user = userEvent.setup();
    const client = fakeClient((_url, init) =>
      (init.headers as Record<string, string>).Authorization === 'Bearer good-token-0123456789' ? jsonResponse(200, CAPS_FULL) : jsonResponse(401, ERR('UNAUTHORIZED', 'a valid bearer token is required')),
    );
    wrap(client, <AuthGate title="Generate"><p>the screen</p></AuthGate>);
    expect(await screen.findByText('This server asks for an API token.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Generate' })).toBeInTheDocument();
    expect(screen.queryByText('the screen')).toBeNull();
    await user.type(screen.getByLabelText('API token'), 'good-token-0123456789');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('the screen')).toBeInTheDocument();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('good-token');
  });

  it('AuthGate: an unreachable server is a banner with retry, not a blank page', async () => {
    let ok = false;
    const client = fakeClient(() => {
      if (!ok) throw new TypeError('x');
      return jsonResponse(200, CAPS_FULL);
    });
    const user = userEvent.setup();
    wrap(client, <AuthGate title="Generate"><p>the screen</p></AuthGate>);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not reach the server');
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('the screen')).toBeInTheDocument();
  });
});

describe('Announcer', () => {
  it('speaks through one polite status region; the same message twice is a change each time', async () => {
    function Button2() {
      const announce = useAnnounce();
      return <button onClick={() => announce('Done')}>go</button>;
    }
    const user = userEvent.setup();
    render(
      <AnnouncerProvider>
        <Button2 />
        <LiveRegion />
      </AnnouncerProvider>,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getByText('go'));
    const first = region.textContent;
    await user.click(screen.getByText('go'));
    expect(first?.trim()).toBe('Done');
    expect(region.textContent).not.toBe(first);
  });
});

describe('useLoad', () => {
  it('drops an answer that arrives after a newer request', async () => {
    const resolvers: Array<(v: string) => void> = [];
    function Show({ k }: { k: string }) {
      const [s] = useLoad(() => new Promise<string>((r) => resolvers.push(r)), [k]);
      return <p>{s.kind === 'ok' ? s.data : s.kind}</p>;
    }
    const { rerender } = render(<Show k="a" />);
    rerender(<Show k="b" />);
    await act(async () => {
      resolvers[1]!('second');
      resolvers[0]!('first');
    });
    await waitFor(() => expect(screen.getByText('second')).toBeInTheDocument());
  });
});

describe('bars and trace', () => {
  it('fmt keeps numbers short', () => {
    expect([fmt(0.5), fmt(12.345), fmt(123.4), fmt(0)]).toEqual(['0.5', '12.3', '123', '0']);
  });

  it('a bar is an image with the number in its name; the fill never exceeds the track; signed bars grow from the middle', () => {
    const { container } = render(
      <>
        <Bar value={5} max={10} label="half" />
        <Bar value={50} max={10} label="over" />
        <Bar value={-5} max={10} signed label="neg" />
      </>,
    );
    expect(screen.getByRole('img', { name: 'half' })).toBeInTheDocument();
    const fills = [...container.querySelectorAll('.gw-bar__fill')];
    expect(fills.map((f) => Number(f.getAttribute('width')))).toEqual([80, 160, 40]);
    expect(Number(fills[2]!.getAttribute('x'))).toBe(40);
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('BarTable is a labelled data table with the number printed beside each bar', () => {
    render(<BarTable caption="Profile" rows={[{ label: 'Average', value: 11.4, max: 40, unit: 'words' }]} />);
    expect(screen.getByRole('table', { name: 'Profile' })).toHaveTextContent('Average11.4 words');
  });

  it('indicators are counts only; a missing filter says it did not report', () => {
    expect(countsFromTrace(TRACE)).toEqual({ banned: 3, redactions: 1 });
    render(<Indicators trace={TRACE} />);
    expect(screen.getByTestId('indicator-Banned phrases')).toHaveTextContent('Banned phrases: 3 removed or replaced');
    expect(screen.getByTestId('indicator-Confidentiality')).toHaveTextContent('Confidentiality: 1 redaction');
    expect(countsFromTrace([])).toEqual({ banned: undefined, redactions: undefined });
    expect(countsFromTrace([{ filter: 'style', modified: false, ms: 1, metadata: {}, error: 'boom' }]).banned).toBeUndefined();
  });

  it('the trace table lists every entry, filters by name, and shows hostile metadata as literal text', async () => {
    const user = userEvent.setup();
    const hostile = [...TRACE, { filter: HOSTILE.img, modified: true, ms: 2, metadata: { note: HOSTILE.script } }];
    const { container } = render(<TraceTable trace={hostile} />);
    expect(screen.getAllByRole('row')).toHaveLength(1 + hostile.length);
    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByText(HOSTILE.script, { exact: false })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: /Filter the trace/ }), 'sty');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByRole('searchbox', { name: /Filter the trace/ }));
    await user.type(screen.getByRole('searchbox', { name: /Filter the trace/ }), 'zzz');
    expect(screen.getByText(/No trace entry matches/)).toBeInTheDocument();
  });

  it('axe: a banner, a trace and a bar table have no violations', async () => {
    const { container } = render(
      <main>
        <ErrorBanner error={new ApiError(502, 'LLM_FAILED', 'm')} onRetry={() => undefined} />
        <Indicators trace={TRACE} />
        <TraceTable trace={TRACE} />
        <BarTable caption="Profile" rows={[{ label: 'Average', value: 11.4, max: 40 }]} />
      </main>,
    );
    const r = await runAxe(container);
    expect(describeViolations(r.violations)).toBe('');
  });
});
