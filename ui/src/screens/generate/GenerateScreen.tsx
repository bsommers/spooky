// Generate: pick an author and a persona, give a draft, get text back in the author's voice (POST /api/generate).
// The output is the server's answer rendered as plain text. The trace and the indicators show what the safety filters did,
// as counts. Nothing from the model is ever interpreted as markup.
import { useRef, useState } from 'react';
import { Button, Form, Label, Radio, RadioGroup, Switch } from 'react-aria-components';
import type { ApiError, PostResponse } from '../../api/client';
import { useCapabilities } from '../../api/capabilities';
import { useApi } from '../../api/context';
import { useAnnounce } from '../../components/Announcer';
import { Caveat } from '../../components/Caveat';
import { CopyButton } from '../../components/CopyButton';
import { ErrorBanner } from '../../components/ErrorBanner';
import { toApiError } from '../../components/errors';
import { NumberInput } from '../../components/NumberInput';
import { Picker } from '../../components/Picker';
import { PlainText } from '../../components/PlainText';
import { Loading, Section } from '../../components/Section';
import { TopicCaveat } from '../../components/TopicCaveat';
import { TextInput } from '../../components/TextInput';
import { Indicators, TraceTable } from '../../components/Trace';
import { useAbortable } from '../../components/useAbortable';
import { useLoad } from '../../components/useLoad';

type Result = PostResponse<'/api/generate'>;
type Mode = 'rewrite' | 'topic';
type LengthChoice = 'auto' | 'short' | 'medium' | 'long';

const LENGTHS: readonly { id: LengthChoice; label: string }[] = [
  { id: 'auto', label: 'Let the model choose' },
  { id: 'short', label: 'Short' },
  { id: 'medium', label: 'Medium' },
  { id: 'long', label: 'Long' },
];

export default function GenerateScreen() {
  const api = useApi();
  const announce = useAnnounce();
  const { begin, cancel } = useAbortable();
  const submitButton = useRef<HTMLButtonElement>(null);
  const { has } = useCapabilities();
  const [authors, reloadAuthors] = useLoad(() => api.get('/api/authors').then((r) => r.authors), [api]);
  const [personas, reloadPersonas] = useLoad(() => api.get('/api/personas').then((r) => r.personas), [api]);
  const [config, reloadConfig] = useLoad(() => api.get('/api/config').then((r) => r.config), [api]);

  const [authorId, setAuthorId] = useState<string | undefined>(undefined);
  const [persona, setPersona] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('rewrite');
  // Each mode keeps its own text, so switching the mode never throws away what was typed.
  const [text, setText] = useState('');
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [length, setLength] = useState<LengthChoice>('auto');
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
  const isTopic = mode === 'topic';
  const mainText = isTopic ? topic : text;
  const mainOver = cap !== undefined && mainText.length > cap;
  const notesOver = isTopic && cap !== undefined && notes.length > cap;
  const over = mainOver || notesOver;
  const empty = mainText.trim() === '';
  const canHumanize = has('humanize');
  const showCaveat = canHumanize && (humanize || resultHumanized);
  const targetBad = canHumanize && humanize && !Number.isFinite(target ?? defaultTarget);
  const ready = chosenAuthor !== undefined && chosenPersona !== undefined && !empty && !over && cap !== undefined && !targetBad;

  const submit = async () => {
    if (!ready || busy || chosenAuthor === undefined || chosenPersona === undefined) return;
    const signal = begin();
    setBusy(true);
    setError(undefined);
    setResult(undefined); // the output on screen belongs to the previous request: never show it next to a new one or its error
    setResultHumanized(false);
    announce('Generating...');
    try {
      const r = await api.post('/api/generate', {
        authorId: chosenAuthor,
        persona: chosenPersona,
        text: mainText,
        ...(isTopic ? { mode: 'topic' as const, ...(notes.trim() === '' ? {} : { notes }), ...(length === 'auto' ? {} : { length }) } : {}),
        ...(canHumanize && humanize ? { humanize: true, ...(target === undefined ? {} : { target }) } : {}),
      }, { signal });
      setResult(r);
      setResultHumanized(canHumanize && humanize);
      announce(`Generation finished: ${r.text.length.toLocaleString('en-US')} characters`);
    } catch (e) {
      const err = toApiError(e);
      setError(err);
      announce(''); // the error banner (role=alert) says it; speaking it again from the live region would read it twice
    } finally {
      setBusy(false);
    }
  };

  const loading = authors.kind === 'loading' || personas.kind === 'loading' || config.kind === 'loading';
  const loadError = authors.kind === 'error' ? authors.error : personas.kind === 'error' ? personas.error : config.kind === 'error' ? config.error : undefined;

  return (
    <section aria-labelledby="gen-h" className="gw-page">
      <h1 id="gen-h">Generate</h1>
      <p className="gw-lede">Write in an author&apos;s voice for a persona: rewrite a draft you have, or write new text about a topic. What you type goes to the server&apos;s model through its safety filters; the answer is shown as plain text.</p>
      {loading && <Loading what="authors, personas and limits" />}
      {loadError !== undefined && (
        <ErrorBanner
          error={loadError}
          onRetry={() => {
            reloadAuthors();
            reloadPersonas();
            reloadConfig();
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
            <Picker label="Author" items={authorList.map((a) => ({ id: a.authorId, label: `${a.displayName} (${a.authorId})` }))} value={chosenAuthor} onChange={setAuthorId} isDisabled={busy} />
            <Picker label="Persona" items={personaList.map((p) => ({ id: p.key, label: p.name }))} value={chosenPersona} onChange={setPersona} isDisabled={busy} />
          </div>
          <RadioGroup className="gw-modes" value={mode} onChange={(v) => setMode(v as Mode)} orientation="horizontal" isDisabled={busy}>
            <Label className="gw-label">What should the model do?</Label>
            <div className="gw-radios">
              <Radio value="rewrite" className="gw-radio">
                <span className="gw-radio__dot" />
                Rewrite my draft
              </Radio>
              <Radio value="topic" className="gw-radio">
                <span className="gw-radio__dot" />
                Write about a topic
              </Radio>
            </div>
          </RadioGroup>
          {isTopic ? (
            <>
              <p className="gw-hint" data-testid="topic-help">
                The model writes new text from the topic and your notes, in the author&apos;s voice. Nothing is looked up online: it has no web search and may state things that are wrong, so it is told to take specific facts, numbers, names and quotes only from your notes.
              </p>
              <TextInput label="Topic we're researching" value={topic} onChange={setTopic} cap={cap} rows={3} isDisabled={busy} hint="A subject, not a draft. Sent to the server's model after the confidentiality filter." />
              <TextInput label="Notes and facts to use (optional)" value={notes} onChange={setNotes} cap={cap} rows={8} isDisabled={busy} hint="The only place the model may take specific facts from. Also filtered before it is sent." />
              <Picker label="Length" items={LENGTHS} value={length} onChange={(id) => setLength(id as LengthChoice)} isDisabled={busy} />
            </>
          ) : (
            <TextInput label="Draft" value={text} onChange={setText} cap={cap} isDisabled={busy} hint="Sent to the server's model after the confidentiality filter." />
          )}
          {canHumanize && (
            <div className="gw-row">
              <Switch className="gw-switch" isSelected={humanize} onChange={setHumanize}>
                <div className="gw-switch__track">
                  <div className="gw-switch__thumb" />
                </div>
                Humanize the result
              </Switch>
              {humanize && <NumberInput label="Target score (0 to 1)" value={target ?? defaultTarget} onChange={setTarget} min={0} max={1} step={0.05} />}
            </div>
          )}
          {showCaveat && <Caveat />}
          <div className="gw-row">
            <Button ref={submitButton} type="submit" className="gw-btn gw-btn--primary" isDisabled={!ready} aria-disabled={busy || undefined}>
              {busy ? 'Generating...' : 'Generate'}
            </Button>
            {busy && (
              <Button
                className="gw-btn"
                onPress={() => {
                  cancel();
                  submitButton.current?.focus(); // the Cancel button is about to go away: keep focus on the form
                }}
              >
                Cancel
              </Button>
            )}
            {!ready && !busy && (
              <span className="gw-hint">{empty ? (isTopic ? 'Write a topic to enable Generate.' : 'Write a draft to enable Generate.') : notesOver ? 'The notes are over the limit.' : over ? (isTopic ? 'The topic is over the limit.' : 'The draft is over the limit.') : targetBad ? 'Enter a target score from 0 to 1.' : 'Waiting for the server limits.'}</span>
            )}
          </div>
        </Form>
      )}
      {error !== undefined && <ErrorBanner error={error} />}
      {result !== undefined && (
        <div className="gw-stack" aria-busy={busy}>
          <Section title="Output">
            {result.mode === 'topic' && <TopicCaveat text={result.caveat} />}
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
