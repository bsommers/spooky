// Authors and ingest: the authors the server knows (GET /api/authors), one author's stylometric profile
// (GET /api/profile), and the form that adds one (POST /api/ingest). A pasted text and a chosen file end up in the same
// text box; the file is read in the browser and sent as text, never uploaded as a file. Corpus text is untrusted.
import { useState } from 'react';
import { Button, FieldError, FileTrigger, Form, Input, Label, ListBox, ListBoxItem, TextArea, TextField } from 'react-aria-components';
import { useApi } from '../../api/context';
import type { GetResponse } from '../../api/client';
import { useAnnounce } from '../../components/Announcer';
import { BarTable } from '../../components/Bars';
import { ErrorBanner } from '../../components/ErrorBanner';
import { toApiError } from '../../components/errors';
import { KeyValues, Loading, Section } from '../../components/Section';
import { useLoad } from '../../components/useLoad';
import { CheckIcon } from '../../icons';
import type { ApiError } from '../../api/client';

type Profile = GetResponse<'/api/profile'>['profile'];

/** Mirrors the server's `authorId` pattern (src/service/schemas.ts), so a bad id is caught before the request. */
export const AUTHOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A file bigger than this is refused in the browser; the server has its own, larger, body limit. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

function ProfileView({ p }: { p: Profile }) {
  return (
    <div data-testid="profile">
      <KeyValues
        rows={[
          ['Author id', <code key="id">{p.authorId}</code>],
          ['Corpus size', `${p.corpusWordCount.toLocaleString('en-US')} words`],
          ['Preferred punctuation', p.preferredPunctuation.length === 0 ? 'none' : p.preferredPunctuation.join(' ')],
          ['Common transitions', p.commonTransitionWords.length === 0 ? 'none' : p.commonTransitionWords.join(', ')],
        ]}
      />
      <BarTable
        caption={`Stylometric profile of ${p.displayName}`}
        rows={[
          { label: 'Average sentence length', value: p.avgSentenceLength, max: 40, unit: 'words' },
          { label: 'Sentence length spread', value: p.sentenceLengthStdDev, max: 20, unit: 'words' },
          { label: 'Lexical density', value: p.lexicalDensityRatio, max: 1 },
          { label: 'Hedging per 100 words', value: p.hedgingFrequency, max: 5 },
          { label: 'Active-voice share', value: p.activePassiveRatio, max: 1 },
        ]}
      />
    </div>
  );
}

function IngestForm({ onDone }: { onDone(authorId: string): void }) {
  const api = useApi();
  const announce = useAnnounce();
  const [authorId, setAuthorId] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [fileNote, setFileNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);

  const idBad = authorId !== '' && !AUTHOR_ID.test(authorId);
  const ready = AUTHOR_ID.test(authorId) && name.trim() !== '' && name.length <= 200 && text.trim() !== '';

  const readFile = async (files: FileList | null) => {
    const f = files?.[0];
    if (f === undefined) return;
    if (f.size > MAX_FILE_BYTES) {
      setFileNote(`${f.name} is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB; choose a smaller file or paste an excerpt.`);
      return;
    }
    try {
      const body = await f.text();
      if (body.includes('\u0000')) {
        setFileNote(`${f.name} does not look like a text file.`);
        return;
      }
      setText(body);
      setFileNote(`Loaded ${f.name} (${body.length.toLocaleString('en-US')} characters) into the text box.`);
      announce(`Loaded ${f.name}`);
    } catch {
      setFileNote(`Could not read ${f.name}.`);
    }
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const r = await api.post('/api/ingest', { authorId, name: name.trim(), text });
      setDone(r.profile.authorId);
      announce(`Ingested ${r.profile.displayName}`);
      onDone(r.profile.authorId);
    } catch (e) {
      const err = toApiError(e);
      setError(err);
      announce(`Ingest failed: ${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Ingest an author">
      <Form
        className="gw-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField className="gw-field" value={authorId} onChange={setAuthorId} isInvalid={idBad} isRequired>
          <Label className="gw-label">Author id</Label>
          <Input className="gw-input" spellCheck={false} autoComplete="off" />
          <FieldError className="gw-field__error">Use letters, digits, dots, dashes or underscores, starting with a letter or digit (up to 64).</FieldError>
        </TextField>
        <TextField className="gw-field" value={name} onChange={setName} isRequired maxLength={200}>
          <Label className="gw-label">Display name</Label>
          <Input className="gw-input" autoComplete="off" />
        </TextField>
        <TextField className="gw-field gw-field--wide" value={text} onChange={setText} isRequired>
          <Label className="gw-label">Writing sample</Label>
          <TextArea className="gw-input gw-textarea" rows={8} spellCheck={false} />
          <span className="gw-hint" data-testid="ingest-count">
            {text.length.toLocaleString('en-US')} characters
          </span>
        </TextField>
        <div className="gw-row">
          <FileTrigger acceptedFileTypes={['text/plain', 'text/markdown', '.txt', '.md']} onSelect={(files) => void readFile(files === null ? null : (files as unknown as FileList))}>
            <Button className="gw-btn">Choose a text file</Button>
          </FileTrigger>
          <span className="gw-hint">Read in your browser and put in the box above; nothing is uploaded until you ingest.</span>
        </div>
        {fileNote !== undefined && (
          <p className="gw-hint" role="status">
            {fileNote}
          </p>
        )}
        <p className="gw-hint">Ingesting an id that already exists replaces that author&apos;s corpus and profile.</p>
        <div className="gw-row">
          <Button type="submit" className="gw-btn gw-btn--primary" isDisabled={!ready} isPending={busy}>
            {busy ? 'Ingesting...' : 'Ingest'}
          </Button>
          {!ready && !busy && <span className="gw-hint">Needs a valid id, a name and some text.</span>}
        </div>
      </Form>
      {done !== undefined && (
        <p className="gw-status gw-status--success" data-testid="ingest-done">
          <CheckIcon size={16} /> Ingested <code>{done}</code>.
        </p>
      )}
      {error !== undefined && <ErrorBanner error={error} />}
    </Section>
  );
}

export default function AuthorsScreen() {
  const api = useApi();
  const [authors, reloadAuthors] = useLoad(() => api.get('/api/authors').then((r) => r.authors), [api]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const list = authors.kind === 'ok' ? authors.data : [];
  const selected = picked !== undefined && list.some((a) => a.authorId === picked) ? picked : list[0]?.authorId;
  const [profile, reloadProfile] = useLoad(
    () => (selected === undefined ? Promise.resolve(undefined) : api.get('/api/profile', { authorId: selected }).then((r) => r.profile)),
    [api, selected],
  );

  return (
    <section aria-labelledby="authors-h" className="gw-page">
      <h1 id="authors-h">Authors and ingest</h1>
      <p className="gw-lede">An author is a writing sample turned into a style profile. Ingest one here, then generate in that voice.</p>
      <div className="gw-split">
        <div className="gw-stack">
          <Section title="Authors">
            {authors.kind === 'loading' && <Loading what="authors" />}
            {authors.kind === 'error' && <ErrorBanner error={authors.error} onRetry={reloadAuthors} />}
            {authors.kind === 'ok' && list.length === 0 && (
              <p data-testid="empty">No authors yet. Ingest a writing sample with the form to get started.</p>
            )}
            {list.length > 0 && (
              <ListBox
                aria-label="Authors"
                className="gw-listbox gw-listbox--list"
                selectionMode="single"
              selectionBehavior="replace"
                disallowEmptySelection
                selectedKeys={selected === undefined ? [] : [selected]}
                onSelectionChange={(keys) => {
                  const k = [...keys][0];
                  if (k !== undefined) setPicked(String(k));
                }}
                items={list.map((a) => ({ id: a.authorId, name: a.displayName, words: a.corpusWordCount }))}
              >
                {(item) => (
                  <ListBoxItem id={item.id} textValue={`${item.name} (${item.id})`} className="gw-listbox__item">
                    <span>
                      {item.name} <span className="gw-hint">({item.id}, {item.words.toLocaleString('en-US')} words)</span>
                    </span>
                  </ListBoxItem>
                )}
              </ListBox>
            )}
          </Section>
          {selected !== undefined && (
            <Section title="Style profile">
              {profile.kind === 'loading' && <Loading what="the profile" />}
              {profile.kind === 'error' && <ErrorBanner error={profile.error} onRetry={reloadProfile} />}
              {profile.kind === 'ok' && profile.data !== undefined && <ProfileView p={profile.data} />}
            </Section>
          )}
        </div>
        <IngestForm
          onDone={(id) => {
            setPicked(id);
            reloadAuthors();
            reloadProfile();
          }}
        />
      </div>
    </section>
  );
}
