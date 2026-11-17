// The weak-scorer caveat, one component for every screen that shows or produces a humanize/score result. The text is the
// registry's, word for word (tests/security/ui-score-caveat.test.ts).
import { HUMANIZE_CAVEAT } from '../screens/score/caveat';
import { WarningIcon } from '../icons';

export function Caveat() {
  return (
    <div role="note" className="gw-banner gw-banner--warning" data-testid="caveat">
      <WarningIcon size={20} className="gw-banner__icon" />
      <div className="gw-banner__body">
        <p className="gw-banner__title">Read this first: the score is a weak proxy.</p>
        <p>{HUMANIZE_CAVEAT}</p>
      </div>
    </div>
  );
}
