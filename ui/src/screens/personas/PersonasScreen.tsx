// Personas: the audiences the server can write for (GET /api/personas). Read-only. Every field is rendered as text.
import { useState } from 'react';
import { ListBox, ListBoxItem } from 'react-aria-components';
import { useApi } from '../../api/context';
import type { GetResponse } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import { KeyValues, Loading, Section } from '../../components/Section';
import { useLoad } from '../../components/useLoad';

type Persona = GetResponse<'/api/personas'>['personas'][number];

function Detail({ p }: { p: Persona }) {
  return (
    <Section title={p.name} className="gw-persona">
      <KeyValues rows={[['Key', <code key="k">{p.key}</code>], ['Cognitive load', p.cognitiveLoad], ['Information density', p.informationDensity]]} />
      <h3>Structural mandates</h3>
      {p.structuralMandates.length === 0 ? (
        <p className="gw-hint">None.</p>
      ) : (
        <ul className="gw-paw-list">
          {p.structuralMandates.map((m, i) => (
            <li key={`${i}-${m}`}>{m}</li>
          ))}
        </ul>
      )}
      <h3>Banned phrases ({p.bannedPhrases.length})</h3>
      {p.bannedPhrases.length === 0 ? (
        <p className="gw-hint">None.</p>
      ) : (
        <ul className="gw-chips">
          {p.bannedPhrases.map((b, i) => (
            <li key={`${i}-${b}`} className="gw-chip">
              {b}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function PersonasScreen() {
  const api = useApi();
  const [load, reload] = useLoad(() => api.get('/api/personas').then((r) => r.personas), [api]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const personas = load.kind === 'ok' ? load.data : [];
  const current = personas.find((p) => p.key === picked) ?? personas[0];
  return (
    <section aria-labelledby="personas-h" className="gw-page">
      <h1 id="personas-h">Personas</h1>
      <p className="gw-lede">The audiences a draft can be written for. They are defined in the server&apos;s config file; this page only shows them.</p>
      {load.kind === 'loading' && <Loading what="personas" />}
      {load.kind === 'error' && <ErrorBanner error={load.error} onRetry={reload} />}
      {load.kind === 'ok' && personas.length === 0 && (
        <div className="gw-card" data-testid="empty">
          <p>No personas are configured. Add them under <code>personas</code> in the server&apos;s config file, then restart the server.</p>
        </div>
      )}
      {current !== undefined && (
        <div className="gw-split">
          <div className="gw-card">
            <h2 id="persona-list-h">Personas</h2>
            <ListBox
              aria-labelledby="persona-list-h"
              className="gw-listbox gw-listbox--list"
              selectionMode="single"
              selectionBehavior="replace"
              disallowEmptySelection
              selectedKeys={[current.key]}
              onSelectionChange={(keys) => {
                const k = [...keys][0];
                if (k !== undefined) setPicked(String(k));
              }}
              items={personas.map((p) => ({ id: p.key, name: p.name }))}
            >
              {(item) => (
                <ListBoxItem id={item.id} textValue={item.name} className="gw-listbox__item">
                  <span>{item.name}</span>
                </ListBoxItem>
              )}
            </ListBox>
          </div>
          <Detail p={current} />
        </div>
      )}
    </section>
  );
}
