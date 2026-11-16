// Generate: pick an author and a persona, give a draft, get text back in the author's voice (POST /api/generate).
// The output is the server's answer rendered as plain text. The trace and the indicators show what the safety filters did,
// as counts. Nothing from the model is ever interpreted as markup.
import { useState } from 'react';
import { Button, Form, Label, NumberField, Input, Switch } from 'react-aria-components';
import type { ApiError, PostResponse } from '../../api/client';
import { useCapabilities } from '../../api/capabilities';
import { useApi } from '../../api/context';
import { useAnnounce } from '../../components/Announcer';
import { Caveat } from '../../components/Caveat';
import { CopyButton } from '../../components/CopyButton';
import { ErrorBanner } from '../../components/ErrorBanner';
import { toApiError } from '../../components/errors';
import { Picker } from '../../components/Picker';
import { PlainText } from '../../components/PlainText';
import { Loading, Section } from '../../components/Section';
import { TextInput } from '../../components/TextInput';
import { Indicators, TraceTable } from '../../components/Trace';
import { useLoad } from '../../components/useLoad';

type Result = PostResponse<'/api/generate'>;

export default function GenerateScreen() {
  const api = useApi();
  const announce = useAnnounce();
  const { has } = useCapabilities();
  const [authors, reloadAuthors] = useLoad(() => api.get('/api/authors').then((r) => r.authors), [api]);
  const [personas, reloadPersonas] = useLoad(() => api.get('/api/personas').then((r) => r.personas), [api]);
  const [config] = useLoad(() => api.get('/api/config').then((r) => r.config), [api]);

  const [authorId, setAuthorId] = useState<string | undefined>(undefined);
  const [persona, setPersona] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [humanize, setHumanize] = useState(false);
  // undefined = the user has not edited it: the field shows the server's configured default and the request omits it.
  const [target, setTarget] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [result, setResult] = useState<Result | undefined>(undefined);
  // The result on screen came from a humanize request: the caveat stays up even if the switch is turned off afterwards.
  const [resultHumanized, setResultHumanized] = useState(false);

  const authorList = authors.kind === 'ok' ? authors.data : [];
  const personaList = personas.kind === 'ok' ? personas.data : [];
  const chosenAuthor = authorId ?? authorList[0]?.authorId;
  const chosenPersona = persona ?? personaList[0]?.key;
  const cap = config.kind === 'ok' ? config.data.limits.maxInputChars : undefined;
  const defaultTarget = config.kind === 'ok' ? config.data.humanize.targetScore : Number.NaN;
  const over = cap !== undefined && text.length > cap;
  const empty = text.trim() === '';
  const canHumanize = has('humanize');
  const showCaveat = canHumanize && (humanize || resultHumanized);
  const ready = chosenAuthor !== undefined && chosenPersona !== undefined && !empty && !over && cap !== undefined;

  const submit = async () => {
    if (!ready || busy || chosenAuthor === undefined || chosenPersona === undefined) return;
    setBusy(true);
    setError(undefined);
    announce('Generating...');
    try {
      const r = await api.post('/api/generate', {
        authorId: chosenAuthor,
        persona: chosenPersona,
        text,
        ...(canHumanize && humanize ? { humanize: true, ...(target === undefined ? {} : { target }) } : {}),
      });
      setResult(r);
      setResultHumanized(canHumanize && humanize);
      announce(`Generation finished: ${r.text.length.toLocaleString('en-US')} characters`);
    } catch (e) {
      const err = toApiError(e);
      setError(err);
      announce(`Generation failed: ${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const loading = authors.kind === 'loading' || personas.kind === 'loading' || config.kind === 'loading';
  const loadError = authors.kind === 'error' ? authors.error : personas.kind === 'error' ? personas.error : config.kind === 'error' ? config.error : undefined;

  return (
    <section aria-labelledby="gen-h" className="gw-page">
      <h1 id="gen-h">Generate</h1>
      <p className="gw-lede">Write a draft in an author&apos;s voice for a persona. The text goes to the server&apos;s model through its safety filters; the answer is shown as plain text.</p>
      {loading && <Loading what="authors, personas and limits" />}
      {loadError !== undefined && (
        <ErrorBanner
          error={loadError}
          onRetry={() => {
            reloadAuthors();
            reloadPersonas();
          }}
        />
      )}
      {!loading && loadError === undefined && authorList.length === 0 && (
        <div className="gw-card" data-testid="empty">
          <p>
            There are no authors yet. <a href="#/authors">Ingest a writing sample</a> first.
          </p>
        </div>
      )}
      {!loading && loadError === undefined && authorList.length > 0 && personaList.length === 0 && (
        <div className="gw-card" data-testid="empty">
          <p>No personas are configured on the server. Add some under <code>personas</code> in its config file.</p>
        </div>
      )}
      {!loading && loadError === undefined && authorList.length > 0 && personaList.length > 0 && (
        <Form
          className="gw-card gw-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="gw-row gw-row--top">
            <Picker label="Author" items={authorList.map((a) => ({ id: a.authorId, label: `${a.displayName} (${a.authorId})` }))} value={chosenAuthor} onChange={setAuthorId} />
            <Picker label="Persona" items={personaList.map((p) => ({ id: p.key, label: p.name }))} value={chosenPersona} onChange={setPersona} />
          </div>
          <TextInput label="Draft" value={text} onChange={setText} cap={cap} isDisabled={busy} hint="Sent to the server's model after the confidentiality filter." />
          {canHumanize && (
            <div className="gw-row">
              <Switch className="gw-switch" isSelected={humanize} onChange={setHumanize}>
                <div className="gw-switch__track">
                  <div className="gw-switch__thumb" />
                </div>
                Humanize the result
              </Switch>
              {humanize && (
                <NumberField className="gw-field gw-field--inline" value={target ?? defaultTarget} onChange={setTarget} minValue={0} maxValue={1} step={0.05}>
                  <Label className="gw-label">Target score (0 to 1)</Label>
                  <Input className="gw-input" />
                </NumberField>
              )}
            </div>
          )}
          {showCaveat && <Caveat />}
          <div className="gw-row">
            <Button type="submit" className="gw-btn gw-btn--primary" isDisabled={!ready} aria-disabled={busy || undefined}>
              {busy ? 'Generating...' : 'Generate'}
            </Button>
            {!ready && !busy && (
              <span className="gw-hint">{empty ? 'Write a draft to enable Generate.' : over ? 'The draft is over the limit.' : 'Waiting for the server limits.'}</span>
            )}
          </div>
        </Form>
      )}
      {error !== undefined && <ErrorBanner error={error} />}
      {result !== undefined && (
        <div className="gw-stack" aria-busy={busy}>
          <Section title="Output">
            <PlainText text={result.text} label="Generated text" />
            <div className="gw-row">
              <CopyButton text={result.text} label="Copy output" />
              <span className="gw-hint">
                {result.text.length.toLocaleString('en-US')} characters, about {result.promptTokensEstimate.toLocaleString('en-US')} prompt tokens
              </span>
            </div>
            <Indicators trace={result.trace} />
          </Section>
          <Section title="Filter trace">
            <TraceTable trace={result.trace} />
          </Section>
        </div>
      )}
    </section>
  );
}
