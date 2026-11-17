// Model output, corpus text and persona text are untrusted: they are rendered as a text node and nothing else. No HTML,
// no Markdown, no link detection. `white-space: pre-wrap` (class) keeps the line breaks.
export function PlainText({ text, label, className }: { text: string; label: string; className?: string }) {
  return (
    <div className={`gw-plain${className === undefined ? '' : ` ${className}`}`} role="region" aria-label={label} tabIndex={0} data-testid="plain-text">
      {text}
    </div>
  );
}
