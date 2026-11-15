import { useId } from 'react';
import type { ReactNode } from 'react';

/** A titled card; the heading names the region for assistive technology. */
export function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`gw-card${className === undefined ? '' : ` ${className}`}`}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

export function KeyValues({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="gw-dl">
      {rows.map(([k, v]) => (
        <div key={k} className="gw-dl__row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="gw-hint">
      Loading {what}...
    </p>
  );
}
