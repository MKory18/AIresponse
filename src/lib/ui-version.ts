/**
 * مفتاح الواجهة (2.3ب، 06-WORK-PACKAGES): `uiVersion: "v1" | "v2"`.
 * - **كوكي المعاينة** `zr-ui` (v1 | v2) بيغلب إعداد المساحة — المالك بيجرّب الواجهة الجديدة على بياناته الحقيقية بلا ما يتأثر فريقه.
 * - **إعداد المساحة** `integrationSettings.uiVersion` (الافتراضي v1) — تفعيل الواجهة الجديدة للكل = ضغطة المالك.
 * - الهيكل و**كل صفحة** بيختاروا النسخة منه، فكل حزمة بتندمج بـ`main` بلا ما تكسر الموقع. حزمة 3.8 بتشيل `v1`.
 */

export type UiVersion = "v1" | "v2";

export const UI_VERSION_COOKIE = "zr-ui";
export const DEFAULT_UI_VERSION: UiVersion = "v1";

export function parseUiVersion(value: unknown): UiVersion | null {
  return value === "v1" || value === "v2" ? value : null;
}

/** الكوكي (إن صحّ) ثم إعداد المساحة ثم الافتراضي. قيم تالفة = تتجاهل. */
export function resolveUiVersion(input: { cookie?: unknown; setting?: unknown }): UiVersion {
  return parseUiVersion(input.cookie) ?? parseUiVersion(input.setting) ?? DEFAULT_UI_VERSION;
}
