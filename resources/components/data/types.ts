/** Lifecycle of an async data surface; the frame primitives render one
 * layout per state so a title never disappears while its rows load. */
export type DataState = "loading" | "error" | "empty" | "ready"

/** Derive a DataState from the usual TanStack query flags plus a row count. */
export function dataState(
  isLoading: boolean,
  isError: boolean,
  count: number,
): DataState {
  if (isLoading) return "loading"
  if (isError) return "error"
  return count > 0 ? "ready" : "empty"
}
