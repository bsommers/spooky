// The one place a failed request is shown: the typed code picks the wording; the server's message is added as text.
import { Button } from 'react-aria-components';
import type { ApiError } from '../api/client';
import { WarningIcon } from '../icons';
import { copyFor } from './errors';

export function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const copy = copyFor(error.code);
  const wait = error.retryAfterSeconds === undefined ? '' : ` Try again in ${error.retryAfterSeconds} seconds.`;
  return (
    <div role="alert" className="gw-banner gw-banner--danger" data-code={error.code}>
      <WarningIcon size={20} className="gw-banner__icon" />
      <div className="gw-banner__body">
        <p className="gw-banner__title">
          {copy.title}
          {wait}
        </p>
        {copy.hint !== undefined && <p className="gw-banner__hint">{copy.hint}</p>}
        <p className="gw-banner__detail">
          <span>{error.message}</span> <code>{error.code}</code>
        </p>
        {onRetry !== undefined && (
          <Button className="gw-btn" onPress={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
