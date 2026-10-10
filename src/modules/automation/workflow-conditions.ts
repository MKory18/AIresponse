import type { Condition, ConditionGroup } from "./workflow-schemas";

/**
 * Typed condition evaluator (P7) — deterministic, no eval/newFunction.
 * Field access is allowlist-checked upstream by the Zod schema; the evaluator
 * only reads prebuilt, ownership-verified context objects.
 */

function getPath(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  if (parts.length > 3) return undefined;
  let cur: unknown = data;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function compare(actual: unknown, operator: Condition["operator"], expected: unknown): boolean {
  const num = (v: unknown) => Number(v);
  switch (operator) {
    case "EQ": return actual === expected || String(actual) === String(expected);
    case "NEQ": return !(actual === expected || String(actual) === String(expected));
    case "GT": return num(actual) > num(expected);
    case "GTE": return num(actual) >= num(expected);
    case "LT": return num(actual) < num(expected);
    case "LTE": return num(actual) <= num(expected);
    case "CONTAINS": return String(actual ?? "").includes(String(expected));
    case "NOT_CONTAINS": return !String(actual ?? "").includes(String(expected));
    case "IN": return Array.isArray(expected) && expected.includes(String(actual));
    case "NOT_IN": return Array.isArray(expected) && !expected.includes(String(actual));
    case "EXISTS": return actual !== undefined && actual !== null;
    case "NOT_EXISTS": return actual === undefined || actual === null;
    default: return false;
  }
}

export function evaluateCondition(condition: Condition, data: Record<string, unknown>): boolean {
  const self = compare(getPath(data, condition.field), condition.operator, condition.value);
  const allOk = (condition.and ?? []).every((c) => evaluateCondition(c, data));
  const anyOk = (condition.or ?? []).length === 0 || (condition.or ?? []).some((c) => evaluateCondition(c, data));
  return self && allOk && anyOk;
}

export function evaluateConditionGroup(group: ConditionGroup | undefined, data: Record<string, unknown>): boolean {
  if (!group) return true;
  const allOk = (group.all ?? []).every((c) => evaluateCondition(c, data));
  const anyOk = (group.any ?? []).length === 0 || (group.any ?? []).some((c) => evaluateCondition(c, data));
  return allOk && anyOk;
}

export interface ConditionOutcome {
  ok: boolean;
  /** First failing condition (field only — never values) for safe logs. */
  reason?: string;
}

/** Detailed evaluation for BRANCH/trace: reports which condition failed. */
export function evaluateConditionDetailed(group: ConditionGroup | undefined, data: Record<string, unknown>): ConditionOutcome {
  if (!group) return { ok: true };
  for (const c of group.all ?? []) {
    if (!evaluateCondition(c, data)) return { ok: false, reason: c.field };
  }
  const any = group.any ?? [];
  if (any.length > 0 && !any.some((c) => evaluateCondition(c, data))) {
    return { ok: false, reason: any[0].field };
  }
  return { ok: true };
}
