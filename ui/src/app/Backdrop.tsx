/** Decorative background layers; every visual detail comes from `--gw-bg-*` tokens, so the theme owns the look. */
export function Backdrop() {
  return (
    <div className="gw-backdrop" aria-hidden="true">
      <div className="gw-backdrop__art" />
      <div className="gw-backdrop__grid" />
      <div className="gw-backdrop__mark" />
    </div>
  );
}
