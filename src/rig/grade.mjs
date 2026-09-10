// Grades a finished run against ANSWER, from the answer text and the trace.
//
// The answer alone is not enough. loop-engineering found that a run can name
// the right device without doing the work, and do the work and still land on
// the plausible wrong one. So this reports what the trace did as well as what
// the answer says.

import { ANSWER } from './task.mjs';

const ID = /\b[A-Z]{2}\d-\d{3}\b/g;

export function grade(run) {
  const text = run.answer ?? '';
  const final = [...text.matchAll(/^\s*\**FINAL:?\**\s*([A-Z]{2}\d-\d{3})\s+vs\.?\s+([A-Z]{2}\d-\d{3})/gim)].at(-1);
  const answerId = final?.[1] ?? text.match(ID)?.[0] ?? null;
  const compareId = final?.[2] ?? null;

  const calls = run.trace.flatMap((t) => t.calls ?? []);
  const narrowed = calls.some((c) => c.input?.min_hours !== undefined || c.input?.max_hours !== undefined);
  const modelLookup = calls.some((c) => c.name === 'top_devices' && c.input?.model === ANSWER.model);
  // Did the right device ever appear in anything the agent was shown?
  const sawAnswer = calls.some((c) => String(c.result).includes(ANSWER.device_id));

  return {
    answerId,
    compareId,
    hadFinalLine: Boolean(final),
    correct: answerId === ANSWER.device_id,
    compareCorrect: compareId === ANSWER.highest_risk_same_model.device_id,
    shortcut: answerId === ANSWER.shortcut_wrong_answer,
    narrowed,
    modelLookup,
    sawAnswer,
  };
}
