/**
 * What a page hands its desktop filter bar: one entry per field the Filter
 * menu lists. A field holds its include list and, when the page can exclude
 * on it, its exclude list. The bar draws a chip per list that has values.
 */
import type { LucideIcon } from "lucide-react"

export type FilterMode = "is" | "not"

type FilterValue = string | number

interface FilterBarFieldBase<T extends FilterValue> {
  id: string
  /** The name in the Filter menu, the picker's header and an empty chip. */
  label: string
  /** A shorter name on a chip with values, such as "IP". */
  chipLabel?: string
  icon: LucideIcon
  include: T[]
  /** Present when the page can exclude on this field, which gives it is / is not. */
  exclude?: T[]
  /** Sets both lists in one write. */
  onChange: (include: T[], exclude: T[]) => void
  labelFor: (value: T) => string
  /** How a value shows on a chip; defaults to labelFor. */
  chipValue?: (value: T) => React.ReactNode
  /** Values on the chip in the monospace face, such as addresses and hosts. */
  mono?: boolean
  /** How many values a chip names before "+N". */
  chipValues?: number
}

export interface ListFilterBarField<T extends FilterValue> extends FilterBarFieldBase<T> {
  picker: "list"
  options: T[]
  iconFor?: (value: T) => React.ReactNode
  loading?: boolean
  emptyText?: string
  /** Fired when the field's picker opens, to load its options. */
  onOpen?: () => void
}

export interface TypedFilterBarField extends FilterBarFieldBase<string> {
  picker: "typed"
  validate: (value: string) => boolean
  hint?: (value: string) => string | null
  placeholder: string
  /** The line under the field, after "Enter adds it." */
  help: string
}

/** Values are erased to string | number here; listField keeps each page's field typed. */
export type FilterBarField = ListFilterBarField<FilterValue> | TypedFilterBarField

/** Values of one list as a chip shows them. */
export function chipValues(field: FilterBarField, mode: FilterMode): FilterValue[] {
  return mode === "is" ? field.include : (field.exclude ?? [])
}

/** One chip per mode that has values, "is" before "is not". */
export function activeModes(field: FilterBarField): FilterMode[] {
  const modes: FilterMode[] = []
  if (field.include.length > 0) modes.push("is")
  if ((field.exclude?.length ?? 0) > 0) modes.push("not")
  return modes
}

export const chipId = (fieldId: string, mode: FilterMode) => `${fieldId}:${mode}`

export function parseChipId(id: string): { fieldId: string; mode: FilterMode } {
  const at = id.lastIndexOf(":")
  return { fieldId: id.slice(0, at), mode: id.slice(at + 1) === "not" ? "not" : "is" }
}

/**
 * Moves a field's values to the other mode, merged with what is there. The
 * picker's is / is not switch does this.
 */
export function switchMode<T extends FilterValue>(
  include: T[],
  exclude: T[],
  to: FilterMode,
): { include: T[]; exclude: T[] } {
  if (to === "not") return { include: [], exclude: [...new Set([...exclude, ...include])] }
  return { include: [...new Set([...include, ...exclude])], exclude: [] }
}

/**
 * Keeps chips in the order they arrived. Ids already known keep their place,
 * new ones go to the end in the order given, and gone ones drop out.
 */
export function orderChips(previous: readonly string[], active: readonly string[]): string[] {
  const kept = previous.filter((id) => active.includes(id))
  return [...kept, ...active.filter((id) => !kept.includes(id))]
}

/** A list field, typed by its values; the bar handles every field alike. */
export function listField<T extends FilterValue>(
  field: Omit<ListFilterBarField<T>, "picker">,
): FilterBarField {
  return { ...field, picker: "list" } as unknown as FilterBarField
}

export function typedField(field: Omit<TypedFilterBarField, "picker">): FilterBarField {
  return { ...field, picker: "typed" }
}
