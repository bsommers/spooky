// Said with every topic result: nothing was looked up and no fact was checked. The server sends the text (`caveat`); if a
// result somehow lacks it, the bundled copy (equal to the server's, tests/security/ui-topic-caveat.test.ts) is shown, so a
// topic result never appears without it. Rendered as a text node.
import { TOPIC_CAVEAT } from '../screens/generate/topicCaveat';
import { WarningIcon } from '../icons';

export function TopicCaveat({ text }: { text?: string | undefined }) {
  return (
    <div role="note" className="gw-banner gw-banner--warning" data-testid="topic-caveat">
      <WarningIcon size={20} className="gw-banner__icon" />
      <div className="gw-banner__body">
        <p className="gw-banner__title">Read this first: the facts in this text are not verified.</p>
        <p>{text !== undefined && text !== '' ? text : TOPIC_CAVEAT}</p>
      </div>
    </div>
  );
}
