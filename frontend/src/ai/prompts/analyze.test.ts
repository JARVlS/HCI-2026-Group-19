import { describe, expect, it } from 'vitest';
import type { AnalyzeInput } from '../provider';
import { ANALYZE_SYSTEM, analyzeMessage } from './analyze';

const input = (over: Partial<AnalyzeInput> = {}): AnalyzeInput => ({
  conversationId: 'c',
  text: 'I think it measures disorder',
  linter: { mode: 'own', confidence: 0.9, reasons: ['Shares your view'] },
  recent: [],
  context: { mode: 'own', pendingQuiz: null, known: [{ id: 'entropy', label: 'Entropy', score: 0.5 }], nudge: 'active', studyMode: false },
  graph: [
    { id: 'phys', label: 'Physics', kind: 'subject', parentId: null },
    { id: 'thermo', label: 'Thermodynamics', kind: 'topic', parentId: 'phys' },
    { id: 'entropy', label: 'Entropy', kind: 'concept', parentId: 'thermo' },
  ],
  subjectId: 'phys',
  ...over,
});

describe('analyze prompt', () => {
  it('has a rubric with one example per mode', () => {
    for (const mode of ['own', 'together', 'ai']) expect(ANALYZE_SYSTEM).toMatch(new RegExp(`^- ${mode}: .*Example: "`, 'm'));
  });

  it('lists the subject, the graph with ids and the message to judge last', () => {
    const m = analyzeMessage(input());
    expect(m).toContain('Conversation subject: Physics (phys)');
    expect(m).toContain('thermo | topic | Thermodynamics | phys');
    expect(m).toContain('(this is the first message)');
    expect(m.endsWith('Student message to judge:\nI think it measures disorder')).toBe(true);
    // The linter's label stays out: the analysis is the independent second opinion.
    expect(m).not.toContain('Shares your view');
  });

  it('marks a quiz answer and cuts long earlier turns', () => {
    const m = analyzeMessage(
      input({
        subjectId: null,
        context: { ...input().context, pendingQuiz: 'entropy' },
        recent: [
          { role: 'user', text: 'Quiz me on entropy' },
          { role: 'assistant', text: `What does entropy measure? ${'x'.repeat(900)}` },
        ],
      }),
    );
    expect(m).toContain('Conversation subject: none yet');
    expect(m).toContain("The message answers the tutor's quiz question about: Entropy (entropy)");
    expect(m).toContain('student: Quiz me on entropy');
    expect(m).toMatch(/tutor: What does entropy measure\? x+…\n/);
    expect(m.length).toBeLessThan(1500);
  });
});
