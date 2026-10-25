/**
 * Helpers for the app version string.
 *
 * The API sends the raw PEP 440 version (0.22.0.dev4+g52b67d62c); only display
 * code formats it. These rules mirror geometrikks/lib/versioning.py for the
 * normalized versions the API sends: release numbers, an optional .devN and an
 * optional PEP 440 local suffix. Pre and post releases (rc, post) don't parse
 * here and fall back to the unparseable rules, which is fine because the API
 * only sends hatch-vcs output.
 */

export const LOCAL_BUILD_LABEL = "local build"

const VERSION_PATTERN = /^(\d+(?:\.\d+)*)(?:\.dev(\d+))?(?:\+([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*))?$/

/** True for an empty or "unknown" version and for an all-zero release. */
export function isLocalBuild(version: string): boolean {
  if (version === "" || version === "unknown") return true
  const match = VERSION_PATTERN.exec(version)
  return match !== null && match[1].split(".").every((part) => Number(part) === 0)
}

/** The version without its +local suffix. */
export function publicVersion(version: string): string {
  const suffixStart = version.indexOf("+")
  return suffixStart === -1 ? version : version.slice(0, suffixStart)
}

/** Tag style: 0.22.0.dev4 becomes v0.22.0-dev.4. */
export function displayVersion(version: string): string {
  if (isLocalBuild(version)) return LOCAL_BUILD_LABEL
  const match = VERSION_PATTERN.exec(version)
  if (match === null) return /^\d/.test(version) ? `v${version}` : version
  const [, release, dev, local] = match
  return `v${release}${dev === undefined ? "" : `-dev.${Number(dev)}`}${local === undefined ? "" : `+${local}`}`
}

/** True when two versions match apart from the +local suffix. A local build
 *  matches anything, since it carries no release to compare. */
export function sameRelease(a: string, b: string): boolean {
  if (isLocalBuild(a) || isLocalBuild(b)) return true
  if (!VERSION_PATTERN.test(a) || !VERSION_PATTERN.test(b)) return a === b
  return publicVersion(a) === publicVersion(b)
}
