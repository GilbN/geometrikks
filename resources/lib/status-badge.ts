/** Tailwind classes for an HTTP status chip, by response class. Shared by
 * the access-logs and debug-logs tables. */
export function statusBadgeClass(code: number): string {
  if (code >= 500) return "bg-red-500/15 text-red-600 dark:text-red-400"
  if (code >= 400) return "bg-amber-500/15 text-amber-600 dark:text-amber-400"
  if (code >= 300) return "bg-sky-500/15 text-sky-600 dark:text-sky-400"
  return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
}
