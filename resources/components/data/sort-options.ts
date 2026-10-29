/** How a sortable field reads, which decides the words for each order. */
export type SortKind = "time" | "number" | "text" | "flag"

export interface SortOption<F extends string> {
  field: F
  label: string
  kind: SortKind
}

const ORDER_LABELS: Record<SortKind, Record<"asc" | "desc", string>> = {
  time: { desc: "Newest first", asc: "Oldest first" },
  number: { desc: "Highest first", asc: "Lowest first" },
  text: { desc: "Z to A", asc: "A to Z" },
  flag: { desc: "Yes first", asc: "No first" },
}

export function sortOrderLabel(kind: SortKind, order: "asc" | "desc"): string {
  return ORDER_LABELS[kind][order]
}

/** The sortable columns of a table, in column order, as drawer options. */
export function sortOptions<F extends string>(
  columns: readonly { label: string; sortField?: F; sortKind?: SortKind }[],
): SortOption<F>[] {
  return columns.flatMap((column) =>
    column.sortField ? [{ field: column.sortField, label: column.label, kind: column.sortKind ?? "text" }] : [],
  )
}
