// Score and Humanize (Phase 8 operations, gated on the server's capability list). Both use the local heuristic, which is
// a weak, confounded proxy: the caveat is on screen at all times, not only next to a result.
import { useRef, useState } from 'react';
import { Button, Form, Switch, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import type { ApiError, GetResponse, PostResponse } from '../../api/client';
import { useCapabilities } from '../../api/capabilities';
import { useApi } from '../../api/context';
import { useAnnounce } from '../../components/Announcer';
import { Bar, BarTable, fmt } from '../../components/Bars';
import { Caveat } from '../../components/Caveat';
import { CopyButton } from '../../components/CopyButton';
import { ErrorBanner } from '../../components/ErrorBanner';
import { toApiError } from '../../components/errors';
import { NumberInput } from '../../components/NumberInput';
import { Picker } from '../../components/Picker';
import { PlainText } from '../../components/PlainText';
import { KeyValues, Section } from '../../components/Section';
import { TextInput } from '../../components/TextInput';
import { TraceTable } from '../../components/Trace';
import { useAbortable } from '../../components/useAbortable';
import { useLoad } from '../../components/useLoad';
import { CheckIcon, WarningIcon } from '../../icons';

type ScoreResult = PostResponse<'/api/score'>;
type HumanizeResult = PostResponse<'/api/humanize'>;

const NO_AUTHOR = '__none__';

function Unavailable({ what }: { what: string }) {
  return (
    <div className="gw-card" data-testid="unavailable">
      <p className="gw-status gw-status--warning">
        <WarningIcon size={18} /> {what} is not available on this server.
      </p>
      <p className="gw-hint">The server&apos;s capability list does not include it, so this panel is turned off. Update the server to a version that offers it.</p>
    </div>
  );
}

type ServerConfig = GetResponse<'/api/config'>['config'];

/** The server's configuration: the input cap and the humanize defaults the panels start from. */
function useServerConfig() {
  const api = useApi();
  const [load, reload] = useLoad(() => api.get('/api/config').then((r) => r.config), [api]);
  const config: ServerConfig | undefined = load.kind === 'ok' ? load.data : undefined;
  return { config, error: load.kind === 'error' ? load.error : undefined, reload };
}

/** Why the submit button is off, in words. Empty when it is on. */
function whyNot({ empty, over, waiting, numbers }: { empty: boolean; over: boolean; waiting: boolean; numbers?: boolean }, action: string): string {
  if (waiting) return 'Waiting for the server limits.';
  if (empty) return `Write some text to enable ${action}.`;
  if (over) return 'The text is over the limit.';
  if (numbers === false) return 'Enter a target score and a number of iterations.';
  return '';
}

function ScorePanel() {
  const api = useApi();
  const announce = useAnnounce();
  const { begin, cancel } = useAbortable();
  const submitButton = useRef<HTMLButtonElement>(null);
  const { config, error: configError, reload: reloadConfig } = useServerConfig();
  const cap = config?.limits.maxInputChars;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [result, setResult] = useState<ScoreResult | undefined>(undefined);
  const ready = text.trim() !== '' && cap !== undefined && text.length <= cap;
  const why = whyNot({ empty: text.trim() === '', over: cap !== undefined && text.length > cap, waiting: cap === undefined }, 'Score');

  const submit = async () => {
    if (!ready || busy) return;
    const signal = begin();
    setBusy(true);
    setError(undefined);
    setResult(undefined); // never leave the previous result next to a new request or its error
    announce('Scoring...');
    try {
      const r = await api.post('/api/score', { text }, { signal });
      setResult(r);
      announce(`Score ${fmt(r.score)}`);
    } catch (e) {
      const err = toApiError(e);
      setError(err);
      announce(`Scoring failed: ${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const features = result === undefined ? [] : Object.entries(result.local.features);
  const maxContribution = Math.max(0.0001, ...features.map(([, f]) => Math.abs(f.contribution)));
  return (
    <div className="gw-stack">
      <Form
        className="gw-card gw-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {configError !== undefined && <ErrorBanner error={configError} onRetry={reloadConfig} />}
        <TextInput label="Text to score" value={text} onChange={setText} cap={cap} isDisabled={busy} />
        <div className="gw-row">
          <Button ref={submitButton} type="submit" className="gw-btn gw-btn--primary" isDisabled={!ready} aria-disabled={busy || undefined}>
            {busy ? 'Scoring...' : 'Score'}
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
          {!ready && !busy && <span className="gw-hint">{why}</span>}
        </div>
      </Form>
      {error !== undefined && <ErrorBanner error={error} />}
      {result !== undefined && (
        <>
          <Section title="Score">
            <p className="gw-bignum" data-testid="score-value">
              {fmt(result.score)} <span className="gw-hint">of 1 (higher reads as more machine-like to this heuristic)</span>
            </p>
            <Bar value={result.score} max={1} label={`Score ${fmt(result.score)} of 1`} />
            {result.localOnly === true && <p className="gw-hint">Local heuristic only; no external detector contributed.</p>}
            {result.local.stats !== undefined && (
              <KeyValues rows={[['Words', result.local.stats.words], ['Sentences', result.local.stats.sentences], ['Paragraphs', result.local.stats.paragraphs]]} />
            )}
            {result.local.flags !== undefined && result.local.flags.length > 0 && (
              <p>
                Flags: {result.local.flags.map((f, i) => (
                  <code key={`${i}-${f}`} className="gw-chip">
                    {f}
                  </code>
                ))}
              </p>
            )}
          </Section>
          <Section title="Per-feature contribution">
            <table className="gw-table gw-bartable">
              <caption className="gw-sr-only">Local heuristic features</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col" className="gw-num">Value</th>
                  <th scope="col" className="gw-num">Weight</th>
                  <th scope="col" className="gw-num">Contribution</th>
                  <th scope="col">
                    <span className="gw-sr-only">Bar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {features.map(([name, f]) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td className="gw-num">{fmt(f.value)}</td>
                    <td className="gw-num">{fmt(f.weight)}</td>
                    <td className="gw-num">{fmt(f.contribution)}</td>
                    <td>
                      <Bar value={f.contribution} max={maxContribution} label={`${name} contribution ${fmt(f.contribution)}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Ensemble">
            <table className="gw-table">
              <caption className="gw-sr-only">Scorers that contributed</caption>
              <thead>
                <tr>
                  <th scope="col">Scorer</th>
                  <th scope="col" className="gw-num">Score</th>
                  <th scope="col" className="gw-num">Weight</th>
                </tr>
              </thead>
              <tbody>
                {result.members.map((m) => (
                  <tr key={m.name}>
                    <th scope="row">{m.name}</th>
                    <td className="gw-num">{fmt(m.score)}</td>
                    <td className="gw-num">{fmt(m.weight)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.excluded.length > 0 && (
              <ul className="gw-meta">
                {result.excluded.map((x) => (
                  <li key={x.name}>
                    <code>{x.name}</code> was left out: {x.reason}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Filter trace">
            <TraceTable trace={result.trace} />
          </Section>
        </>
      )}
    </div>
  );
}

function HumanizePanel() {
  const api = useApi();
  const announce = useAnnounce();
  const { begin, cancel } = useAbortable();
  const submitButton = useRef<HTMLButtonElement>(null);
  const { config, error: configError, reload: reloadConfig } = useServerConfig();
  const cap = config?.limits.maxInputChars;
  const [authors] = useLoad(() => api.get('/api/authors').then((r) => r.authors), [api]);
  const [text, setText] = useState('');
  const [authorId, setAuthorId] = useState(NO_AUTHOR);
  // undefined = not edited: the field shows the server's configured default and the request omits it.
  const [target, setTarget] = useState<number | undefined>(undefined);
  const [iterations, setIterations] = useState<number | undefined>(undefined);
  const [useModel, setUseModel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [result, setResult] = useState<HumanizeResult | undefined>(undefined);
  const targetValue = target ?? config?.humanize.targetScore ?? Number.NaN;
  const iterationsValue = iterations ?? config?.humanize.maxIterations ?? Number.NaN;
  const numbersOk = Number.isFinite(targetValue) && Number.isFinite(iterationsValue);
  const ready = text.trim() !== '' && cap !== undefined && text.length <= cap && numbersOk;
  const why = whyNot({ empty: text.trim() === '', over: cap !== undefined && text.length > cap, waiting: cap === undefined, numbers: numbersOk }, 'Humanize');
  const authorItems = [{ id: NO_AUTHOR, label: 'No author profile' }, ...(authors.kind === 'ok' ? authors.data.map((a) => ({ id: a.authorId, label: `${a.displayName} (${a.authorId})` })) : [])];

  const submit = async () => {
    if (!ready || busy) return;
    const signal = begin();
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    announce('Humanizing...');
    try {
      const r = await api.post('/api/humanize', {
        text,
        ...(target === undefined ? {} : { target }),
        ...(iterations === undefined ? {} : { maxIterations: iterations }),
        llm: useModel,
        ...(authorId === NO_AUTHOR ? {} : { authorId }),
      }, { signal });
      setResult(r);
      announce(`Humanize finished: score ${fmt(r.initialScore)} to ${fmt(r.finalScore)}`);
    } catch (e) {
      const err = toApiError(e);
      setError(err);
      announce(`Humanize failed: ${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const deltaRows = result === undefined ? [] : Object.keys(result.featuresBefore).map((name) => ({ name, before: result.featuresBefore[name] ?? 0, after: result.featuresAfter[name] ?? 0, delta: result.featureDeltas[name] ?? 0 }));
  const maxDelta = Math.max(0.0001, ...deltaRows.map((r) => Math.abs(r.delta)));

  return (
    <div className="gw-stack">
      <Form
        className="gw-card gw-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {configError !== undefined && <ErrorBanner error={configError} onRetry={reloadConfig} />}
        <TextInput label="Text to humanize" value={text} onChange={setText} cap={cap} isDisabled={busy} />
        <div className="gw-row gw-row--top">
          <Picker label="Author profile (optional)" items={authorItems} value={authorId} onChange={setAuthorId} isDisabled={busy} />
          <NumberInput label="Target score (0 to 1)" value={targetValue} onChange={setTarget} min={0} max={1} step={0.05} />
          <NumberInput label="Max iterations (0 to 10)" value={iterationsValue} onChange={setIterations} min={0} max={10} step={1} />
        </div>
        <Switch className="gw-switch" isSelected={useModel} onChange={setUseModel}>
          <div className="gw-switch__track">
            <div className="gw-switch__thumb" />
          </div>
          Allow a model pass (off = deterministic edits only)
        </Switch>
        <div className="gw-row">
          <Button ref={submitButton} type="submit" className="gw-btn gw-btn--primary" isDisabled={!ready} aria-disabled={busy || undefined}>
            {busy ? 'Humanizing...' : 'Humanize'}
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
          {!ready && !busy && <span className="gw-hint">{why}</span>}
        </div>
      </Form>
      {error !== undefined && <ErrorBanner error={error} />}
      {result !== undefined && (
        <>
          <Section title="Result">
            <div className="gw-compare">
              <div>
                <p className="gw-label">Score before</p>
                <p className="gw-bignum" data-testid="score-before">{fmt(result.initialScore)}</p>
                <Bar value={result.initialScore} max={1} label={`Score before ${fmt(result.initialScore)}`} />
              </div>
              <div>
                <p className="gw-label">Score after</p>
                <p className="gw-bignum" data-testid="score-after">{fmt(result.finalScore)}</p>
                <Bar value={result.finalScore} max={1} label={`Score after ${fmt(result.finalScore)}`} />
              </div>
            </div>
            <p className={`gw-status ${result.reachedTarget ? 'gw-status--success' : 'gw-status--warning'}`}>
              {result.reachedTarget ? <CheckIcon size={16} /> : <WarningIcon size={16} />} {result.reachedTarget ? 'The target score was reached.' : 'The target score was not reached.'}
            </p>
            <p className="gw-hint" data-testid="server-caveat">
              {result.caveat}
            </p>
            <KeyValues rows={[['Iterations', result.iterations], ['Model calls', result.llmCalls], ['Edits reverted by the meaning guard', result.guardRejections]]} />
            <PlainText text={result.text} label="Humanized text" />
            <div className="gw-row">
              <CopyButton text={result.text} label="Copy output" />
            </div>
          </Section>
          <Section title="Per-feature change">
            <table className="gw-table gw-bartable">
              <caption className="gw-sr-only">Feature values before and after, and the change</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col" className="gw-num">Before</th>
                  <th scope="col" className="gw-num">After</th>
                  <th scope="col" className="gw-num">Change</th>
                  <th scope="col">
                    <span className="gw-sr-only">Bar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {deltaRows.map((r) => (
                  <tr key={r.name}>
                    <th scope="row">{r.name}</th>
                    <td className="gw-num">{fmt(r.before)}</td>
                    <td className="gw-num">{fmt(r.after)}</td>
                    <td className="gw-num">{fmt(r.delta)}</td>
                    <td>
                      <Bar signed value={r.delta} max={maxDelta} label={`${r.name} changed by ${fmt(r.delta)}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Iteration history">
            <table className="gw-table">
              <caption className="gw-sr-only">Every edit the loop tried, in order</caption>
              <thead>
                <tr>
                  <th scope="col" className="gw-num">#</th>
                  <th scope="col">Step</th>
                  <th scope="col">Targeted features</th>
                  <th scope="col" className="gw-num">Score</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {result.steps.length === 0 && (
                  <tr>
                    <td colSpan={5}>No edit was attempted.</td>
                  </tr>
                )}
                {result.steps.map((s, i) => (
                  <tr key={`${s.iteration}-${s.step}-${i}`} data-outcome={s.outcome}>
                    <td className="gw-num">{s.iteration}</td>
                    <td>{s.step}</td>
                    <td>{s.features.length === 0 ? 'none' : s.features.join(', ')}</td>
                    <td className="gw-num">
                      {fmt(s.scoreBefore)} to {fmt(s.scoreAfter)}
                    </td>
                    <td>
                      <span className={`gw-status ${s.outcome === 'improved' ? 'gw-status--success' : 'gw-status--warning'}`}>
                        {s.outcome === 'improved' ? <CheckIcon size={16} /> : <WarningIcon size={16} />} {s.outcome.replace(/_/g, ' ')}, {s.kept ? 'kept' : 'reverted'}
                      </span>
                      {s.redacted && <span className="gw-hint"> The confidentiality filter changed this edit.</span>}
                      {s.guard.length > 0 && (
                        <ul className="gw-meta" aria-label="Meaning guard reasons">
                          {s.guard.map((g, j) => (
                            <li key={`${j}-${g}`}>{g}</li>
                          ))}
                        </ul>
                      )}
                      {s.error !== undefined && <span className="gw-status gw-status--danger"> {s.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Filter trace">
            <TraceTable trace={result.trace} />
          </Section>
        </>
      )}
    </div>
  );
}

export default function ScoreScreen() {
  const { has } = useCapabilities();
  const canScore = has('score');
  const canHumanize = has('humanize');
  return (
    <section aria-labelledby="score-h" className="gw-page">
      <h1 id="score-h">Score and humanize</h1>
      <p className="gw-lede">Measure how machine-like a text reads to the local heuristic, or rewrite it to score lower while a guard keeps its facts intact.</p>
      <Caveat />
      {/* Both panels stay mounted (the idle one is inert and hidden): switching tabs keeps the text, the result and a request in flight. */}
      <Tabs className="gw-tabs">
        <TabList className="gw-tablist" aria-label="Score or humanize">
          <Tab id="score" className="gw-tab">
            Score
          </Tab>
          <Tab id="humanize" className="gw-tab">
            Humanize
          </Tab>
        </TabList>
        <TabPanel id="score" className="gw-tabpanel" shouldForceMount>
          {canScore ? <ScorePanel /> : <Unavailable what="Scoring" />}
        </TabPanel>
        <TabPanel id="humanize" className="gw-tabpanel" shouldForceMount>
          {canHumanize ? <HumanizePanel /> : <Unavailable what="Humanizing" />}
        </TabPanel>
      </Tabs>
    </section>
  );
}
