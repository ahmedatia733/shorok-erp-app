/** Tiny class-name combiner (subset of clsx; we keep deps lean). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
