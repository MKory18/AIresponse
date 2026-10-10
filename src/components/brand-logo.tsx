import { cn } from "@/lib/cn";

/**
 * Zaki response brand mark — a white "Z" over a deep-blue gradient tile
 * with a chat-bubble tail and a spark accent. Pure SVG/CSS, no assets.
 */
export function BrandLogo({
  size = "md",
  className,
}: {
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const dims: Record<string, string> = {
    xs: "h-7 w-7 rounded-lg",
    sm: "h-8 w-8 rounded-[10px]",
    md: "h-9 w-9 rounded-xl",
    lg: "h-11 w-11 rounded-2xl",
    xl: "h-14 w-14 rounded-[18px]",
  };
  const zSize: Record<string, number> = { xs: 14, sm: 16, md: 18, lg: 22, xl: 28 };
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br from-sky-400 via-brand-500 to-blue-800 text-white",
        "shadow-[0_4px_14px_-2px_rgb(37_99_235/0.55),inset_0_1px_0_rgb(255_255_255/0.35)]",
        dims[size],
        className
      )}
    >
      {/* glossy highlight */}
      <span className="pointer-events-none absolute inset-x-1 top-0 h-1/2 rounded-b-full bg-gradient-to-b from-white/30 to-transparent" />
      <svg
        width={zSize[size]}
        height={zSize[size]}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 4.5h12L6 19.5h12" />
      </svg>
      {/* response spark */}
      <span className="absolute bottom-1 end-1 h-1.5 w-1.5 rounded-full bg-sky-200 shadow-[0_0_6px_2px_rgb(186_230_253/0.9)]" />
    </span>
  );
}
