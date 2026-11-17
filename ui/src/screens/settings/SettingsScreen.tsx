// Settings: what the server is configured with (read-only, from GET /api/config), the theme, and the optional API token.
// The page never shows a key. The server reports only the NAME of the environment variable and whether it is set.
import { useState } from 'react';
import { Button, FieldError, Form, Input, Label, Radio, RadioGroup, TextField } from 'react-aria-components';
import { useApi } from '../../api/context';
import type { GetResponse } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import { KeyValues, Loading, Section } from '../../components/Section';
import { useLoad } from '../../components/useLoad';
import { CheckIcon, WarningIcon } from '../../icons';
import { useTheme } from '../../theme/ThemeProvider';

type Config = GetResponse<'/api/config'>['config'];

function KeyStatus({ env, isSet }: { env: string | undefined; isSet: boolean | undefined }) {
  if (env === undefined) return <span className="gw-hint">No key variable is configured.</span>;
  return (
    <span className="gw-keystatus">
      <code>{env}</code>{' '}
      {isSet === true ? (
        <span className="gw-status gw-status--success">
          <CheckIcon size={16} /> set on the server
        </span>
      ) : (
        <span className="gw-status gw-status--warning">
          <WarningIcon size={16} /> not set on the server
        </span>
      )}
    </span>
  );
}

function ThemeSection() {
  const { themeId, themes, setTheme } = useTheme();
  return (
    <Section title="Appearance">
      <RadioGroup className="gw-radios" value={themeId} onChange={setTheme} aria-label="Theme" orientation="horizontal">
        {themes.map((t) => (
          <Radio key={t.id} value={t.id} className="gw-radio">
            <span className="gw-radio__dot" />
            {t.id === 'black-cat' ? 'Black Cat' : t.id === 'tron-neon' ? 'Tron Neon' : t.label}
          </Radio>
        ))}
      </RadioGroup>
      <p className="gw-hint">The choice is remembered in this browser (the theme id only).</p>
    </Section>
  );
}

function TokenSection() {
  const api = useApi();
  const [held, setHeld] = useState(api.hasToken());
  return (
    <Section title="Authentication">
      <p className="gw-status" role="status">
        {held ? <CheckIcon size={16} /> : <WarningIcon size={16} />} {held ? 'A token is held in memory for this page load.' : 'No token is held. Only needed when the server was started with --token-env.'}
      </p>
      <Form
        className="gw-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const value = String(new FormData(form).get('token') ?? '');
          api.setToken(value);
          setHeld(api.hasToken());
          form.reset();
        }}
      >
        <TextField name="token" type="password" isRequired autoComplete="off" className="gw-field">
          <Label className="gw-label">API token</Label>
          <Input className="gw-input" spellCheck={false} />
          <FieldError className="gw-field__error" />
        </TextField>
        <div className="gw-row">
          <Button type="submit" className="gw-btn gw-btn--primary">
            Use token
          </Button>
          <Button
            className="gw-btn"
            isDisabled={!held}
            onPress={() => {
              api.setToken(undefined);
              setHeld(false);
            }}
          >
            Forget token
          </Button>
        </div>
      </Form>
      <p className="gw-hint">The token is kept in this page&apos;s memory only: never in storage, a cookie or the address. Reloading forgets it.</p>
    </Section>
  );
}

function FilterTable() {
  const api = useApi();
  const [load, reload] = useLoad(() => api.get('/api/filters').then((r) => r.filters), [api]);
  if (load.kind === 'loading') return <Loading what="filters" />;
  if (load.kind === 'error') return <ErrorBanner error={load.error} onRetry={reload} />;
  return (
    <table className="gw-table">
      <caption className="gw-sr-only">Configured filters</caption>
      <thead>
        <tr>
          <th scope="col">Filter</th>
          <th scope="col">Stage</th>
          <th scope="col">On error</th>
          <th scope="col">Enabled</th>
        </tr>
      </thead>
      <tbody>
        {load.data.map((f, i) => (
          <tr key={`${f.name}-${f.stage}-${i}`}>
            <th scope="row">{f.name}</th>
            <td>{f.stage}</td>
            <td>{f.onError}</td>
            <td>{f.enabled ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServerSection({ config }: { config: Config }) {
  const l = config.llm;
  return (
    <>
      <Section title="Model">
        <KeyValues
          rows={[
            ['Provider', l.provider],
            ['Model', l.model],
            ['Endpoint host', l.baseUrlHost ?? 'provider default'],
            ['API key variable', <KeyStatus key="k" env={l.apiKeyEnv} isSet={l.apiKeyEnvSet} />],
            ['Max output tokens', l.maxTokens],
            ['Temperature', l.temperature],
            ['Retries', l.maxRetries],
          ]}
        />
        <p className="gw-hint">The key itself stays in the server&apos;s environment and is never sent to this page.</p>
      </Section>
      <Section title="Limits and storage">
        <KeyValues
          rows={[
            ['Max input characters', config.limits.maxInputChars.toLocaleString('en-US')],
            ['Chunk size / overlap', `${config.chunk.size} / ${config.chunk.overlap}`],
            [
              'State directory',
              config.stateDir === undefined ? (
                <span key="s">none: this server keeps nothing between runs</span>
              ) : (
                <code key="s" className="gw-path">
                  {config.stateDir}
                </code>
              ),
            ],
          ]}
        />
        <p className="gw-hint">
          Where ingested authors are kept. Read-only here: it is set on the server (<code>--state-dir</code> or <code>GHOSTWRITER_STATE_DIR</code>).
        </p>
      </Section>
      <Section title="Filters">
        <FilterTable />
        <KeyValues rows={[['Blocklist terms', config.confidentiality.blocklistTerms], ['Custom rules', config.confidentiality.customRules], ['Personas', config.personas.length === 0 ? 'none' : config.personas.join(', ')]]} />
        <p className="gw-hint">Counts only. The blocklist terms and rules themselves are never sent to this page.</p>
      </Section>
      <Section title="Scoring and humanizing">
        <KeyValues
          rows={[
            ['Local scorer weight', config.scorer.localWeight],
            ['Humanize target score', config.humanize.targetScore],
            ['Humanize max iterations', config.humanize.maxIterations],
          ]}
        />
        {config.scorer.detectors.length === 0 ? (
          <p className="gw-hint">No external detectors are configured; scoring is local only.</p>
        ) : (
          <table className="gw-table">
            <caption className="gw-sr-only">Configured detectors</caption>
            <thead>
              <tr>
                <th scope="col">Detector</th>
                <th scope="col">Host</th>
                <th scope="col">Key variable</th>
                <th scope="col">Weight</th>
              </tr>
            </thead>
            <tbody>
              {config.scorer.detectors.map((d) => (
                <tr key={d.name}>
                  <th scope="row">{d.name}</th>
                  <td>
                    {d.scheme}://{d.host}
                  </td>
                  <td>
                    <KeyStatus env={d.apiKeyEnv} isSet={d.apiKeyEnvSet} />
                  </td>
                  <td>{d.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

export default function SettingsScreen() {
  const api = useApi();
  const [load, reload] = useLoad(() => api.get('/api/config').then((r) => r.config), [api]);
  return (
    <section aria-labelledby="settings-h" className="gw-page">
      <h1 id="settings-h">Settings</h1>
      <p className="gw-lede">What this server is configured with. The configuration is read-only here: it is changed in the server&apos;s config file.</p>
      <div className="gw-stack">
        <ThemeSection />
        <TokenSection />
        {load.kind === 'loading' && <Loading what="the configuration" />}
        {load.kind === 'error' && <ErrorBanner error={load.error} onRetry={reload} />}
        {load.kind === 'ok' && <ServerSection config={load.data} />}
      </div>
    </section>
  );
}
