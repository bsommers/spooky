// The UI shows the topic caveat with every topic result; its copy must be the registry's, word for word, and it is rendered as
// text (no HTML sink).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOPIC_CAVEAT } from '../../config/topic.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]): string => readFileSync(join(root, 'ui', 'src', ...p), 'utf8');

describe('UI topic caveat', () => {
  it('ui/src/screens/generate/topicCaveat.ts equals TOPIC_CAVEAT', () => {
    const m = /TOPIC_CAVEAT =\s*\n?\s*'((?:[^'\\]|\\.)*)'/.exec(read('screens', 'generate', 'topicCaveat.ts'));
    expect(m, 'caveat literal not found').not.toBeNull();
    expect(m![1]!.replace(/\\'/g, "'")).toBe(TOPIC_CAVEAT);
  });

  it('the Generate screen shows the caveat for every topic result, through the shared component, as text', () => {
    const screen = read('screens', 'generate', 'GenerateScreen.tsx');
    expect(screen).toMatch(/result\.mode === 'topic' && <TopicCaveat text=\{result\.caveat\} \/>/);
    const comp = read('components', 'TopicCaveat.tsx');
    expect(comp).toMatch(/\{text !== undefined && text !== '' \? text : TOPIC_CAVEAT\}/);
    expect(comp).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});
