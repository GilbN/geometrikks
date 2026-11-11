export const NEXT = "next";
export const SEMVER = /^\d+\.\d+\.\d+$/;

export type VersionPlan = {
  latest: string | null;
  pending: string[];
  superseded: string[];
  served: string[];
};

export function compareSemver(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function toUrlSlugs(defaultSlugs: string[], latest: string | null): string[] {
  if (latest !== null && defaultSlugs[0] === latest) return defaultSlugs.slice(1);
  return defaultSlugs;
}

export function versionOfUrl(pathname: string): "latest" | "next" {
  return /^\/docs\/next(\/|$)/.test(pathname) ? "next" : "latest";
}

export function withSlash(url: string): string {
  const suffixStart = url.search(/[?#]/);
  const path = suffixStart === -1 ? url : url.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? "" : url.slice(suffixStart);
  return path.endsWith("/") ? url : `${path}/${suffix}`;
}
