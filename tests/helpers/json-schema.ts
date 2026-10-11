/**
 * مدقق JSON Schema مصغّر (draft-07 — المستعمل بعقود المنظومة):
 * النوع · الخصائص · المطلوب · الحرفية · المصفوفات (وtuple) · النمط · الحدود · enum · anyOf.
 * مشترك بين اختبار باب الوكلاء واختبارات العقود (contracts/).
 */
type Row = Record<string, any>;

export function validateJsonSchema(schema: Row, value: unknown, path = "$"): string[] {
  if (schema.anyOf) {
    return (schema.anyOf as Row[]).some((s) => validateJsonSchema(s, value, path).length === 0) ? [] : [`${path}: anyOf`];
  }
  const errs: string[] = [];
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: not object`];
      const obj = value as Row;
      for (const k of (schema.required as string[]) ?? []) if (!(k in obj)) errs.push(`${path}.${k}: required`);
      for (const [k, v] of Object.entries(obj)) {
        const prop = (schema.properties as Row | undefined)?.[k];
        if (prop) errs.push(...validateJsonSchema(prop, v, `${path}.${k}`));
        else if (schema.additionalProperties === false) errs.push(`${path}.${k}: additional property`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errs.push(...validateJsonSchema(schema.additionalProperties, v, `${path}.${k}`));
      }
      return errs;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: not array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: minItems`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: maxItems`);
      // items مصفوفة = tuple (draft-07): كل خانة بمخططها، والزيادة ممنوعة مع additionalItems:false.
      value.forEach((v, i) => {
        if (Array.isArray(schema.items)) {
          const item = (schema.items as Row[])[i];
          if (item) errs.push(...validateJsonSchema(item, v, `${path}[${i}]`));
          else if (schema.additionalItems === false) errs.push(`${path}[${i}]: additional item`);
        } else errs.push(...validateJsonSchema(schema.items, v, `${path}[${i}]`));
      });
      return errs;
    }
    case "string":
      if (typeof value !== "string") return [`${path}: not string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: minLength`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: maxLength`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`);
      if (schema.enum && !(schema.enum as unknown[]).includes(value)) errs.push(`${path}: enum`);
      return errs;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: not number`];
      if (schema.type === "integer" && !Number.isInteger(value)) errs.push(`${path}: not integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: maximum`);
      return errs;
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: not boolean`];
    case "null":
      return value === null ? [] : [`${path}: not null`];
    default:
      return [`${path}: unknown schema type ${String(schema.type)}`];
  }
}
