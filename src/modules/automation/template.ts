/**
 * Template renderer — strict allowlist. Only {{customer.*}}, {{order.*}},
 * {{conversation.*}} with known safe fields. Any other placeholder
 * (constructor/prototype/__proto__/unknown) is REJECTED, not rendered.
 */

const ALLOWED_FIELDS: Record<string, string[]> = {
  customer: ["name", "phone", "province", "status", "id"],
  order: ["id", "orderNumber", "total", "status", "currency", "province"],
  conversation: ["id", "status", "aiState"],
};

const PLACEHOLDER = /\{\{\s*([\p{L}0-9_.]+)\s*\}\}/gu;

export function validateTemplate(template: string): { ok: true } | { ok: false; error: string } {
  const matches = [...template.matchAll(PLACEHOLDER)];
  for (const m of matches) {
    const path = m[1];
    if (/[^\p{L}0-9_.]/u.test(path)) return { ok: false, error: `Invalid placeholder: ${path}` };
    const parts = path.split(".");
    if (parts.length !== 2) return { ok: false, error: `Placeholder must be object.field: ${path}` };
    const [obj, field] = parts;
    const allowed = ALLOWED_FIELDS[obj];
    if (!allowed) return { ok: false, error: `Unknown object in template: ${obj}` };
    if (!allowed.includes(field)) return { ok: false, error: `Unknown field in template: ${path}` };
    // Hard block dangerous tokens even inside allowed objects.
    if (/constructor|prototype|__proto__|eval|function|process/i.test(path)) {
      return { ok: false, error: `Forbidden placeholder: ${path}` };
    }
  }
  return { ok: true };
}

export function renderTemplate(
  template: string,
  data: { customer?: Record<string, unknown>; order?: Record<string, unknown>; conversation?: Record<string, unknown> }
): string {
  const check = validateTemplate(template);
  if (!check.ok) throw new Error(check.error);
  return template.replace(PLACEHOLDER, (_m, path: string) => {
    const [obj, field] = path.split(".");
    const section = (data as Record<string, Record<string, unknown> | undefined>)[obj];
    if (!section) return "";
    const value = section[field];
    return value === undefined || value === null ? "" : String(value);
  });
}
