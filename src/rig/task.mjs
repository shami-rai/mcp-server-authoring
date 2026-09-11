// The task and its ground truth.
//
// Same question as loop-engineering, with one addition: a FINAL line, so a run
// can be graded by a program instead of by reading it. Only SYSTEM and QUESTION
// are ever sent to the model. ANSWER is for the grader.

export const SYSTEM = [
  'You are analysing telemetry from a fleet of connected medical devices.',
  'The tools are your only source of information about the fleet.',
  'Answer the question you are asked.',
  'End your reply with exactly one line of the form',
  '"FINAL: <id of the device that answers the question> vs <id of the highest-risk-scored device of the same model>".',
].join(' ');

export const QUESTION = [
  'Among devices with under 500 operating hours, which had the most unplanned',
  'downtime per 100 operating hours, and how did its vendor risk score compare',
  'to the highest-risk-scored device of the same model?',
].join(' ');

export const ANSWER = {
  device_id: 'AV3-007',
  model: 'Aeris V3',
  downtime_min: 68,
  operating_hours: 76,
  downtime_per_100h: 89.5,
  risk_score: 57,
  highest_risk_same_model: { device_id: 'AV3-024', risk_score: 85, downtime_per_100h: 10.9 },
  // Rank the whole pool once by raw downtime and stop, and you land here. It is 2nd by
  // downtime per operating hour, which is what makes it a convincing wrong answer.
  shortcut_wrong_answer: 'IL7-032',
};
