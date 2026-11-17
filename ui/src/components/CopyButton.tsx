import { useState } from 'react';
import { Button } from 'react-aria-components';
import { CheckIcon, CopyIcon } from '../icons';
import { useAnnounce } from './Announcer';

/** Copies `text` with the Clipboard API when the page may use it; otherwise says so instead of pretending. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const announce = useAnnounce();
  const [done, setDone] = useState(false);
  return (
    <Button
      className="gw-btn"
      onPress={() => {
        const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (clip === undefined || typeof clip.writeText !== 'function') {
          announce('Copy is not available in this browser context. Select the text and copy it by hand.');
          return;
        }
        clip.writeText(text).then(
          () => {
            setDone(true);
            announce('Copied to the clipboard');
            setTimeout(() => setDone(false), 2000);
          },
          () => announce('The browser refused to copy. Select the text and copy it by hand.'),
        );
      }}
    >
      {done ? <CheckIcon size={16} /> : <CopyIcon size={16} />} {done ? 'Copied' : label}
    </Button>
  );
}
