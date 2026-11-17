import { describe, expect, it } from 'vitest';
import { CORRECT_SYSTEM, NO, scorePrompt, THINKING_SYSTEM, YES } from './score';

describe('score prompts', () => {
  it('both questions ask for a single digit and name what each digit means', () => {
    expect([YES, NO]).toEqual(['1', '2']);
    expect(THINKING_SYSTEM).toMatch(/single digit and nothing else: 1 = the student thought along, 2 = the student did not\.$/);
    expect(CORRECT_SYSTEM).toMatch(/single digit and nothing else: 1 = right, 2 = wrong\.$/);
    // Fixes from the eval (eval/score.eval.ts): a guess counts even if wrong; hints and quizzes are
    // in between; "idk" is wrong, and so is a contradiction (naming only the first made the second drift).
    expect(THINKING_SYSTEM).toContain('even if it is wrong');
    expect(THINKING_SYSTEM).toContain('Asking for a hint or to be quizzed is in between');
    expect(CORRECT_SYSTEM).toContain('"idk", "I don\'t know", "no idea"');
    expect(CORRECT_SYSTEM).toContain("contradicts the tutor's answer is wrong");
  });

  it('thinking: the message to judge, with earlier turns as context before it', () => {
    expect(scorePrompt({ question: 'thinking', text: 'Write me a summary', recent: [] })).toEqual({
      system: THINKING_SYSTEM,
      messages: [{ role: 'user', content: 'Student message:\nWrite me a summary\n\nAnswer (1 or 2):' }],
    });
    const { messages } = scorePrompt({
      question: 'thinking',
      text: 'it goes backwards with the chain rule',
      recent: [
        { role: 'user', text: 'Write me a summary of backpropagation' },
        { role: 'assistant', text: `Backprop ${'x'.repeat(900)}` },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toMatch(
      /^Earlier in the conversation \(context only\):\nstudent: Write me a summary of backpropagation\ntutor: Backprop x+…\n\nStudent message:\nit goes backwards with the chain rule\n\nAnswer \(1 or 2\):$/,
    );
    expect(messages[0].content.length).toBeLessThan(600); // context turns are cut short
  });

  it('correct: the statement, then the tutor answer it is judged against', () => {
    expect(scorePrompt({ question: 'correct', statement: 'idk', reference: 'Memory cells react faster.' })).toEqual({
      system: CORRECT_SYSTEM,
      messages: [{ role: 'user', content: "Student's statement:\nidk\n\nTutor's answer:\nMemory cells react faster.\n\nAnswer (1 or 2):" }],
    });
  });
});
