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
  src,
  size = "md",
  ring,
  className,
}: {
  name: string | null | undefined;
  /** Real photo URL (Facebook profile picture). Falls back to initials. */
  src?: string | null;
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
  const shape = cn(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-bold text-white shadow-xs",
    sizes[size],
    ring && "ring-2 ring-white/70 dark:ring-white/10",
    className
  );
  if (src) {
    // Real photo — never a random/placeholder image.
    return <img src={src} alt={display} className={cn(shape, "bg-surface-3 object-cover")} />;
  }
  return (
    <span
      aria-hidden
      className={cn(shape, "bg-gradient-to-br", PALETTES[idx])}
    >
      {initial}
    </span>
  );
}
