// Small horizontal bar charts as inline SVG. Widths are SVG attributes (not style=""), colors come from CSS classes
// that read theme tokens, and every bar has its number printed next to it, so the chart is never the only carrier.
export interface BarDatum {
  label: string;
  value: number;
  /** Value that fills the track. */
  max: number;
  /** Shown after the number, e.g. "words". */
  unit?: string;
  /** Draw the bar from the centre (for signed deltas): `max` is then the largest absolute value. */
  signed?: boolean;
}

const W = 160;
const H = 10;

export function Bar({ value, max, signed = false, label }: { value: number; max: number; signed?: boolean; label: string }) {
  const safeMax = max > 0 ? max : 1;
  const frac = Math.min(1, Math.abs(value) / safeMax);
  if (signed) {
    const half = W / 2;
    const w = frac * half;
    const x = value < 0 ? half - w : half;
    return (
      <svg className="gw-bar" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} focusable="false">
        <rect className="gw-bar__track" x={0} y={0} width={W} height={H} rx={2} />
        <rect className={value < 0 ? 'gw-bar__fill gw-bar__fill--down' : 'gw-bar__fill gw-bar__fill--up'} x={x} y={0} width={w} height={H} rx={2} />
        <rect className="gw-bar__axis" x={half - 0.5} y={0} width={1} height={H} />
      </svg>
    );
  }
  return (
    <svg className="gw-bar" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} focusable="false">
      <rect className="gw-bar__track" x={0} y={0} width={W} height={H} rx={2} />
      <rect className="gw-bar__fill" x={0} y={0} width={frac * W} height={H} rx={2} />
    </svg>
  );
}

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** A table of labelled bars (a data table first: the SVG is the picture of the numbers beside it). */
export function BarTable({ caption, rows, valueHeader = 'Value' }: { caption: string; rows: readonly BarDatum[]; valueHeader?: string }) {
  return (
    <table className="gw-table gw-bartable">
      <caption className="gw-sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Measure</th>
          <th scope="col">{valueHeader}</th>
          <th scope="col">
            <span className="gw-sr-only">Bar</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            <td className="gw-num">
              {fmt(r.value)}
              {r.unit === undefined ? '' : ` ${r.unit}`}
            </td>
            <td>
              <Bar value={r.value} max={r.max} {...(r.signed === undefined ? {} : { signed: r.signed })} label={`${r.label}: ${fmt(r.value)}${r.unit === undefined ? '' : ` ${r.unit}`}, scale up to ${fmt(r.max)}`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
