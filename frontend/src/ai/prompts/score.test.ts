import { describe, expect, it } from 'vitest';
import { CORRECT_SCALE, CORRECT_SYSTEM, GUESS_SYSTEM, scaleScore, scorePrompt, THINKING_SCALE, THINKING_SYSTEM } from './score';

describe('score prompts: rating scales', () => {
  it('thinking: 5 steps from none (0) to all (1); a wrong claim still counts as own thinking', () => {
    expect(THINKING_SCALE).toEqual({ '1': 0, '2': 0.25, '3': 0.5, '4': 0.75, '5': 1 });
    for (const step of ['1 = none', '2 = little', '3 = some', '4 = much', '5 = all']) {
      expect(THINKING_SYSTEM).toContain(step);
      expect(GUESS_SYSTEM).toContain(step);
    }
    expect(THINKING_SYSTEM).toContain('a wrong claim or a misconception is still the student');
    expect(THINKING_SYSTEM).toMatch(/single digit from 1 to 5 and nothing else\.$/);
    expect(GUESS_SYSTEM).toContain('An empty guess, "no idea", "idk" or "just tell me" is 1.');
  });

  it('correct: right (1), partly right (0.5), wrong or no answer (0)', () => {
    expect(CORRECT_SCALE).toEqual({ '1': 1, '2': 0.5, '3': 0 });
    expect(CORRECT_SYSTEM).toContain('2 = partly right');
    expect(CORRECT_SYSTEM).toContain('or it is no answer at all ("idk", "no idea", a question back)');
    expect(CORRECT_SYSTEM).toMatch(/single digit from 1 to 3 and nothing else\.$/);
  });

  it('thinking: the message to rate, with earlier turns as context before it', () => {
    expect(scorePrompt({ question: 'thinking', text: 'Write me a summary', recent: [] })).toEqual({
      system: THINKING_SYSTEM,
      messages: [{ role: 'user', content: 'Student message:\nWrite me a summary\n\nRating (1 to 5):' }],
      scale: THINKING_SCALE,
    });
    const { messages } = scorePrompt({
      question: 'thinking',
      text: 'and the far side?',
      recent: [
        { role: 'user', text: 'Why are there tides?' },
        { role: 'assistant', text: `The moon ${'x'.repeat(900)}` },
      ],
    });
    expect(messages[0].content).toMatch(
      /^Earlier in the conversation \(context only\):\nstudent: Why are there tides\?\ntutor: The moon x+…\n\nStudent message:\nand the far side\?\n\nRating \(1 to 5\):$/,
    );
    expect(messages[0].content.length).toBeLessThan(600); // context turns are cut short
  });

  it('guess: the question as context, the guess as the thing rated', () => {
    expect(scorePrompt({ question: 'guess', prompt: 'Write me a summary of backprop', guess: 'chain rule backwards' })).toEqual({
      system: GUESS_SYSTEM,
      messages: [
        { role: 'user', content: "The student's question:\nWrite me a summary of backprop\n\nThe student's guess, before reading the answer:\nchain rule backwards\n\nRating (1 to 5):" },
      ],
      scale: THINKING_SCALE,
    });
  });

  it('correct: the tutor answer, then the statement and the question right before the cue', () => {
    // The tutor's answer often ends with a question to the student: it must not be the last thing the model reads.
    expect(scorePrompt({ question: 'correct', statement: 'idk', reference: 'Memory cells react faster. What is boosted?' })).toEqual({
      system: CORRECT_SYSTEM,
      messages: [
        { role: 'user', content: "Tutor's answer:\nMemory cells react faster. What is boosted?\n\nStudent's statement:\nidk\n\nIs the student's statement right? Rating (1 to 3):" },
      ],
      scale: CORRECT_SCALE,
    });
  });

  it('the score is the probability-weighted sum over the scale; a missing option is no score', () => {
    expect(scaleScore({ '1': 0, '2': 0, '3': 0, '4': 1, '5': 0 }, THINKING_SCALE)).toBe(0.75);
    expect(scaleScore({ '1': 0.1, '2': 0.1, '3': 0.2, '4': 0.4, '5': 0.2 }, THINKING_SCALE)).toBeCloseTo(0.025 + 0.1 + 0.3 + 0.2);
    expect(scaleScore({ '1': 0.2, '2': 0.6, '3': 0.2 }, CORRECT_SCALE)).toBeCloseTo(0.5);
    expect(scaleScore({ '1': 0.5, '2': 0.5 }, CORRECT_SCALE)).toBeNull();
    expect(scaleScore({ '1': 1, '2': 0, '3': 'x' }, CORRECT_SCALE)).toBeNull();
  });
});
