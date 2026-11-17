/**
 * Runs the app's own code on research inputs, so the research never works from a copy that can
 * drift: the judge prompt comes from `scorePrompt()` and the word-rule baseline from `classify()`
 * and `draftShare()`. Read-only use of the frontend; run with Node's type stripping (Node 22.18+):
 *
 *   node bridge.ts < request.json > response.json
 *
 * request:  {"op": "score_prompt", "inputs": [ScoreInput, ...]}  -> [{"system", "user"}, ...]
 *           {"op": "rules", "texts": ["...", ...]}                -> [{"mode", "confidence", "reasons", "share"}, ...]
 *           {"op": "constants"}                                   -> {"OWN_FROM", "AI_UP_TO", "THINKING_SCALE"}
 */
import { readFileSync } from 'node:fs';
import { scorePrompt, THINKING_SCALE } from '../../frontend/src/ai/prompts/score.ts';
import { classify } from '../../frontend/src/lib/classify.ts';
import { AI_UP_TO, draftShare, OWN_FROM } from '../../frontend/src/lib/modes.ts';

const request = JSON.parse(readFileSync(0, 'utf8'));

function run(req: { op: string; inputs?: unknown[]; texts?: string[] }): unknown {
  switch (req.op) {
    case 'score_prompt':
      return req.inputs!.map((input) => {
        const p = scorePrompt(input as Parameters<typeof scorePrompt>[0]);
        if (p.messages.length !== 1) throw new Error(`scorePrompt returned ${p.messages.length} messages, expected 1`);
        return { system: p.system, user: p.messages[0].content, scale: p.scale };
      });
    case 'rules':
      return req.texts!.map((text) => {
        const c = classify(text);
        return { mode: c.mode, confidence: c.confidence, reasons: c.reasons, share: draftShare(c.mode, c.confidence) };
      });
    case 'constants':
      return { OWN_FROM, AI_UP_TO, THINKING_SCALE };
    default:
      throw new Error(`unknown op ${req.op}`);
  }
}

process.stdout.write(JSON.stringify(run(request)));
