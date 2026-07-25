/**
 * Shared encode/decode plumbing for URL-backed filter state.
 *
 * Filter state on the geo-logs / access-logs / analytics pages lives in the
 * route's search params so filtered views are shareable links. The rules are
 * the same on every page: empty arrays and default scalars drop out of the
 * URL entirely (clean state -> clean link), and changing a filter resets
 * pagination. This module holds that logic as plain functions so it can be
 * unit-tested; use-url-filters.ts wraps it for React.
 */

/** Empty arrays drop out of the URL entirely. */
export function arrayParam<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined
}

/** Default values drop out of the URL entirely. */
export function dropDefault<T>(value: T, fallback: T): T | undefined {
  return value === fallback ? undefined : value
}

export interface FilterCodec<TSearch, TFilters> {
  decode: (search: TSearch) => TFilters
  encode: (filters: TFilters) => Partial<TSearch>
  /** Merged in after every filter change, e.g. `{ page: undefined }`. */
  resetOnChange?: Partial<TSearch>
}

/**
 * Apply a filter update against a search object, returning the next search.
 *
 * Decodes from `prev` rather than a captured snapshot so concurrent updates
 * compose. Keys the codec does not own (page size, sort) pass through.
 */
export function applyFilterUpdate<TSearch extends object, TFilters>(
  prev: TSearch,
  updater: (prev: TFilters) => TFilters,
  codec: FilterCodec<TSearch, TFilters>,
): TSearch {
  const next = updater(codec.decode(prev))
  return { ...prev, ...codec.encode(next), ...(codec.resetOnChange ?? {}) }
}
