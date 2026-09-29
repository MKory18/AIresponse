/**
 * EXPLICIT, documented persona text limits — shared by the API validation and
 * the UI so both show the same contract. Persona text is NEVER silently
 * truncated: over-limit input is rejected with a visible error instead.
 */
export const PERSONA_LIMITS = {
  name: 100,
  systemInstructions: 20_000,
  prohibitedPhrase: 200,
  prohibitedPhrases: 30,
  customRule: 2_000,
  customRules: 30,
} as const;