/**
 * React binding for the URL-backed filter helpers in lib/url-filters.ts.
 *
 * A route passes its validated search plus a codec; this returns the decoded
 * filter state and two writers. Every write uses `replace: true` so tweaking
 * filters does not pile up in browser history.
 *
 * Deliberately thin: vitest runs in a node environment here with no DOM, so
 * hooks cannot be unit-tested. All real logic lives in the pure module.
 */
import { useCallback, useMemo } from "react"
import { applyFilterUpdate, type FilterCodec } from "@/lib/url-filters"

interface UseUrlFiltersOptions<TSearch extends object, TFilters>
  extends FilterCodec<TSearch, TFilters> {
  search: TSearch
  navigate: (opts: { search: (prev: TSearch) => TSearch; replace: boolean }) => void
}

export function useUrlFilters<TSearch extends object, TFilters>({
  search,
  navigate,
  decode,
  encode,
  resetOnChange,
}: UseUrlFiltersOptions<TSearch, TFilters>) {
  const filters = useMemo(() => decode(search), [decode, search])

  const setFilters = useCallback(
    (updater: (prev: TFilters) => TFilters) => {
      navigate({
        search: (prev: TSearch) =>
          applyFilterUpdate(prev, updater, { decode, encode, resetOnChange }),
        replace: true,
      })
    },
    [navigate, decode, encode, resetOnChange],
  )

  const patchSearch = useCallback(
    (patch: Partial<TSearch>) => {
      navigate({ search: (prev: TSearch) => ({ ...prev, ...patch }), replace: true })
    },
    [navigate],
  )

  return { filters, setFilters, patchSearch }
}
