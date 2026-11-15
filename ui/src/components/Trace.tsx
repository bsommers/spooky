// The filter trace of a generate / humanize / score call: which filters ran, whether they changed the text, how long
// they took and their metadata counts. Metadata is shown key by key as text. The indicators show COUNTS only: the
// server never returns the phrases or secrets that were matched, and this page would not render them if it did.
import { useId, useState } from 'react';
import { Input, Label, SearchField, Button } from 'react-aria-components';
import type { PostResponse } from '../api/client';
import { CheckIcon, WarningIcon } from '../icons';

export type TraceEntry = PostResponse<'/api/generate'>['trace'][number];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function countsFromTrace(trace: readonly TraceEntry[]): { banned: number | undefined; redactions: number | undefined } {
  const style = trace.find((t) => t.filter === 'style');
  const conf = trace.find((t) => t.filter === 'confidentiality');
  return {
    banned: style === undefined || style.error !== undefined ? undefined : num(style.metadata.phrases_removed) + num(style.metadata.phrases_replaced),
    redactions: conf === undefined || conf.error !== undefined ? undefined : Object.values(conf.metadata).reduce<number>((a, v) => a + num(v), 0),
  };
}

export function Indicators({ trace }: { trace: readonly TraceEntry[] }) {
  const { banned, redactions } = countsFromTrace(trace);
  const line = (what: string, n: number | undefined, unit: string) =>
    n === undefined ? (
      <li className="gw-status gw-status--warning" data-testid={`indicator-${what}`}>
        <WarningIcon size={16} /> {what}: filter did not report
      </li>
    ) : (
      <li className={`gw-status ${n > 0 ? 'gw-status--warning' : 'gw-status--success'}`} data-testid={`indicator-${what}`}>
        {n > 0 ? <WarningIcon size={16} /> : <CheckIcon size={16} />} {what}: {n} {unit}
      </li>
    );
  return (
    <ul className="gw-indicators" aria-label="Safety filter counts">
      {line('Banned phrases', banned, 'removed or replaced')}
      {line('Confidentiality', redactions, redactions === 1 ? 'redaction' : 'redactions')}
    </ul>
  );
}

export function TraceTable({ trace }: { trace: readonly TraceEntry[] }) {
  const [query, setQuery] = useState('');
  const id = useId();
  const q = query.trim().toLowerCase();
  const rows = q === '' ? trace : trace.filter((t) => t.filter.toLowerCase().includes(q));
  return (
    <div className="gw-trace">
      <SearchField className="gw-field gw-field--inline" value={query} onChange={setQuery} aria-label="Filter the trace by filter name">
        <Label className="gw-label">Filter the trace</Label>
        <div className="gw-searchrow">
          <Input className="gw-input" placeholder="filter name" spellCheck={false} />
          <Button className="gw-btn">Clear</Button>
        </div>
      </SearchField>
      <table className="gw-table" aria-describedby={id}>
        <caption id={id} className="gw-sr-only">
          Filters that ran, in order
        </caption>
        <thead>
          <tr>
            <th scope="col">Filter</th>
            <th scope="col">Modified</th>
            <th scope="col" className="gw-num">
              ms
            </th>
            <th scope="col">Metadata</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4}>No trace entry matches &quot;{query}&quot;.</td>
            </tr>
          )}
          {rows.map((t, i) => (
            <tr key={`${t.filter}-${i}`}>
              <th scope="row">{t.filter}</th>
              <td>{t.modified ? 'Yes' : 'No'}</td>
              <td className="gw-num">{Math.round(t.ms * 100) / 100}</td>
              <td>
                {t.error !== undefined && (
                  <span className="gw-status gw-status--danger">
                    <WarningIcon size={16} /> {t.error}
                  </span>
                )}
                {Object.keys(t.metadata).length === 0 && t.error === undefined ? (
                  <span className="gw-hint">none</span>
                ) : (
                  <ul className="gw-meta">
                    {Object.entries(t.metadata).map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {String(v)}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
