import type { Condition, ConditionGroup } from "./schemas";

/**
 * Typed condition evaluator — deterministic, no eval/newFunction, bounded
 * nesting via Zod schema (max depth through and/or arrays).
 */

function getPath(data: Record<string, unknown>, path: string): unknown {
  // Only 2 levels: object.field — enforced by schema, re-checked here.
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
