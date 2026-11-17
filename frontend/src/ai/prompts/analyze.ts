import { looksLikeQuizAnswer } from '../../lib/classify';
import type { AnalyzeInput } from '../provider';

/**
 * The turn analysis prompt (IMPLEMENTATION_PLAN.md ADR-6), first small version for M3: who did the
 * thinking in one student message, and which concepts of the student's graph it worked on. The
 * answer follows `TURN_ANALYSIS_SCHEMA` (`schemas/turnAnalysis.ts`). M4 adds examples from our
 * needfinding, a graph subtree chosen per turn, and prompt caching.
 *
 * The linter's label is not sent on purpose: the analysis is the second, independent opinion.
 */
export const ANALYZE_SYSTEM = [
  'You judge one message of a student in Arbor, a study chat with an AI tutor. Arbor shows students who did the thinking, and it grows a knowledge graph from the concepts they work on.',
  '',
  "Who did the thinking (mode), judged from the student's message itself:",
  '- own: the student brings their own reasoning, claim, prediction, explanation or answer. Example: "I think overfitting means the model memorised the training data instead of the pattern."',
  '- together: the student explores or checks an idea, asks why or how, asks for a hint, or builds on what the tutor said. Example: "Why does a smaller learning rate help? Is it because big steps overshoot?"',
  '- ai: the student hands the work to the AI and asks for a finished answer, summary, solution or text, with no thinking of their own. Example: "Write me a summary of backpropagation for my exam."',
  '',
  'Return:',
  "- mode and confidence (0 to 1) for the whole message; 1 to 3 short reasons in plain words (e.g. \"Asks for a finished summary\"); evidence: short quotes copied exactly from the student's message (a few words each), each with the mode it points to and why.",
  '- concepts: the 0 to 3 study concepts the message works on (small talk and thanks have none). Each is an existing node of the graph (existingId, its exact id) or a new node: newLabel (1 to 4 words, sentence case), newKind ("concept" for one idea, "topic" for an area that groups concepts), a parent (parentId of an existing node, or parentLabel for a new topic) and a one-line description. Prefer existing nodes and never create one that exists under another name. Put a new concept under the most specific topic it belongs to. Fields that do not apply are null.',
  '  For each concept also: mode; independence (1 = the student did the thinking, 0.5 = together, 0 = the AI did it); correctness from 0 to 1 only when the message can be graded for it (an answer to a quiz question, a prediction, or a claim of their own), otherwise null; confidence; a short reason; evidenceQuote (exact words from the message) or null.',
  '- subject: only when the conversation has no subject yet, the broad field it belongs to (e.g. "Machine learning", "Biology"): existingId of a subject in the graph, or newLabel. Otherwise null.',
].join('\n');

/** Earlier turns are context only; long ones are cut to keep the call small. */
const MAX_TURN_CHARS = 600;
const cut = (t: string) => (t.length > MAX_TURN_CHARS ? `${t.slice(0, MAX_TURN_CHARS)}…` : t);

/** The one user message of the `analyze` call: context first, the message to judge last. */
export function analyzeMessage(input: AnalyzeInput): string {
  const label = (id: string) => input.graph.find((c) => c.id === id)?.label ?? input.context.known.find((k) => k.id === id)?.label ?? id;
  const quiz = input.context.pendingQuiz && looksLikeQuizAnswer(input.text, input.context.pendingQuiz) ? input.context.pendingQuiz : null;
  const lines = [
    `Conversation subject: ${input.subjectId ? `${label(input.subjectId)} (${input.subjectId})` : 'none yet'}`,
    ...(quiz ? [`The message answers the tutor's quiz question about: ${label(quiz)} (${quiz})`] : []),
    '',
    'Graph (id | kind | label | parent id):',
    ...(input.graph.length ? input.graph.map((c) => `${c.id} | ${c.kind} | ${c.label} | ${c.parentId ?? '-'}`) : ['(empty)']),
    '',
    'Conversation so far (oldest first):',
    ...(input.recent.length ? input.recent.map((m) => `${m.role === 'user' ? 'student' : 'tutor'}: ${cut(m.text)}`) : ['(this is the first message)']),
    '',
    'Student message to judge:',
    input.text,
  ];
  return lines.join('\n');
}
