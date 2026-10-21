import { cn } from "@/lib/cn";

/**
 * علامة Zaki response: فقاعة محادثة بيضا والحرف Z **مفرّغ** منها — لون البلاطة
 * بيبان من ورا الحرف. الفقاعة والحرف مسار SVG واحد (`evenodd`): بلا أصول ولا mask.
 *
 * شكل البلاطة بيتبدّل بالثيم من CSS (`data-logo-tile` بـglobals.css): مربّع مدوّر
 * (افتراضي) · نجمة ثمانية (إسلامي) · شمس (المدينة الليلية). الألوان من `--logo-*`.
 * نفس المسار بـ`src/app/icon.svg` (الأيقونة) — `tests/brand-logo.test.ts` بيمنع الانحراف.
 */
export const BRAND_MARK_PATH =
  "M23 17H41A8 8 0 0 1 49 25V35A8 8 0 0 1 41 43H30L21 51L23 43A8 8 0 0 1 15 35V25A8 8 0 0 1 23 17Z " +
  "M23.5 22.5H40.5V26.2L29.7 34H40.5V37.5H23.5V34L34.3 26H23.5Z";
export const BRAND_SPARK_PATH = "M50 8l1.7 4.6L56.3 14.3l-4.6 1.7L50 20.6l-1.7-4.6L43.7 14.3l4.6-1.7z";

const SIZES = { xs: "h-7 w-7", sm: "h-8 w-8", md: "h-9 w-9", lg: "h-11 w-11", xl: "h-14 w-14" } as const;
const RADIUS = {
  xs: "rounded-lg",
  sm: "rounded-[10px]",
  md: "rounded-xl",
  lg: "rounded-2xl",
  xl: "rounded-[18px]",
} as const;

export function BrandLogo({
  size = "md",
  className,
}: {
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span aria-hidden data-brand-logo className={cn("relative flex shrink-0", SIZES[size], className)}>
      <span
        data-logo-tile
        className={cn(
          "absolute inset-0 overflow-hidden bg-gradient-to-br from-logo-from via-logo-via to-logo-to",
          "shadow-[0_4px_14px_-2px_rgb(var(--logo-glow)/0.55),inset_0_1px_0_rgb(255_255_255/0.35)]",
          RADIUS[size]
        )}
      >
        {/* glossy highlight */}
        <span className="pointer-events-none absolute inset-x-1 top-0 h-1/2 rounded-b-full bg-gradient-to-b from-white/30 to-transparent" />
      </span>
      <svg viewBox="0 0 64 64" className="relative h-full w-full">
        <path data-logo-bubble fillRule="evenodd" d={BRAND_MARK_PATH} style={{ fill: "rgb(var(--logo-bubble))" }} />
        <path data-logo-spark d={BRAND_SPARK_PATH} style={{ fill: "rgb(var(--logo-spark))" }} />
      </svg>
    </span>
  );
}
