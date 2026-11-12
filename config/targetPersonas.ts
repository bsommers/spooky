// Default target-audience personas (axis 2). Data only; user config may replace the whole list.
import type { TargetPersonaConfig } from '../src/models/types.js';

export const DEFAULT_PERSONAS: readonly TargetPersonaConfig[] = [
  {
    key: 'engineer',
    name: 'Senior engineer',
    cognitiveLoad: 'high tolerance; comfortable with jargon and terse reasoning',
    informationDensity: 'high; precise terms, concrete numbers, no filler',
    structuralMandates: ['lead with the conclusion', 'state assumptions explicitly', 'prefer lists for steps'],
    bannedPhrases: ['game-changer', 'leverage synergies', 'cutting-edge'],
  },
  {
    key: 'executive',
    name: 'Executive reader',
    cognitiveLoad: 'low; time-poor, wants the decision and its consequence',
    informationDensity: 'medium; outcomes and risks over mechanisms',
    structuralMandates: ['first sentence is the recommendation', 'keep paragraphs under four sentences'],
    bannedPhrases: ['deep dive', 'low-hanging fruit', 'circle back'],
  },
  {
    key: 'newcomer',
    name: 'Newcomer to the topic',
    cognitiveLoad: 'low; needs terms defined on first use',
    informationDensity: 'low; one idea per paragraph with a concrete example',
    structuralMandates: ['define jargon on first use', 'use short sentences', 'end with a one-line recap'],
    bannedPhrases: ['obviously', 'as everyone knows', 'trivially'],
  },
];
