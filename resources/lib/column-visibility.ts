/**
 * Persisted column visibility for the log tables.
 *
 * Only the user's overrides are stored, keyed by column, so the defaults
 * (including the mobile defaults) still decide every column the user has
 * never touched. A column added in a later release shows per its
 * defaultVisible instead of staying hidden behind a saved list, and a
 * removed column's stale override is ignored.
 */
import { useCallback, useEffect, useMemo, useState } from "react"

import { isMobileViewport } from "@/lib/utils"

export interface VisibilityColumn {
  key: string
  defaultVisible: boolean
  mobileHidden?: boolean
}

/** Column key to visible; present only for columns the user toggled. */
export type ColumnOverrides = Record<string, boolean>

export function loadColumnOverrides(storageKey: string): ColumnOverrides {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const overrides: ColumnOverrides = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") overrides[key] = value
    }
    return overrides
  } catch {
    // Storage may be blocked or hold junk; the defaults are always safe.
    return {}
  }
}

export function saveColumnOverrides(storageKey: string, overrides: ColumnOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, JSON.stringify(overrides))
  } catch {
    // Keep the in-memory choice for this session.
  }
}

export function resolveVisibleColumns(
  columns: readonly VisibilityColumn[],
  overrides: ColumnOverrides,
  mobile: boolean,
): Set<string> {
  const visible = new Set<string>()
  for (const c of columns) {
    const shown =
      c.key in overrides ? overrides[c.key] : c.defaultVisible && !(mobile && c.mobileHidden)
    if (shown) visible.add(c.key)
  }
  return visible
}

export function useColumnVisibility<C extends VisibilityColumn>(
  storageKey: string,
  columns: readonly C[],
) {
  const [overrides, setOverrides] = useState<ColumnOverrides>(() =>
    loadColumnOverrides(storageKey),
  )
  // Sampled once per mount, like the mobile defaults always were.
  const [mobile] = useState(isMobileViewport)

  useEffect(() => {
    saveColumnOverrides(storageKey, overrides)
  }, [storageKey, overrides])

  const visible = useMemo(
    () => resolveVisibleColumns(columns, overrides, mobile),
    [columns, overrides, mobile],
  )
  const shownColumns = useMemo(() => columns.filter((c) => visible.has(c.key)), [columns, visible])

  const toggleColumn = useCallback(
    (key: string) => {
      setOverrides((prev) => ({
        ...prev,
        [key]: !resolveVisibleColumns(columns, prev, mobile).has(key),
      }))
    },
    [columns, mobile],
  )
  const resetColumns = useCallback(() => setOverrides({}), [])

  return {
    visible,
    shownColumns,
    toggleColumn,
    resetColumns,
    hasOverrides: Object.keys(overrides).length > 0,
  }
}
