import { cn } from "@/lib/cn";

/** Avatar with automatic initial + stable gradient background from the name. */
const PALETTES = [
  "from-violet-500/90 to-purple-600/90",
  "from-sky-500/90 to-blue-600/90",
  "from-emerald-500/90 to-teal-600/90",
  "from-amber-500/90 to-orange-600/90",
  "from-rose-500/90 to-pink-600/90",
  "from-indigo-500/90 to-violet-600/90",
];

export function Avatar({
  name,
  size = "md",
  ring,
  className,
}: {
  name: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg";
  ring?: boolean;
  className?: string;
}) {
  const display = (name ?? "").trim() || "؟";
  const initial = display.slice(0, 1);
  const idx = [...display].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTES.length;
  const sizes = {
    xs: "h-6 w-6 text-[10px]",
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-12 w-12 text-base",
  };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-br font-bold text-white shadow-xs",
        PALETTES[idx],
        sizes[size],
        ring && "ring-2 ring-white/70 dark:ring-white/10",
        className
      )}
    >
      {initial}
    </span>
  );
}
