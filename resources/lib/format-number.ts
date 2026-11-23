/**
 * Format a number with locale-aware thousand separators.
 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}
