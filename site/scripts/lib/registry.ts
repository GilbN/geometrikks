const TOKEN_URL = "https://ghcr.io/token?scope=repository:gilbn/geometrikks:pull&service=ghcr.io";
const MANIFEST_URL = "https://ghcr.io/v2/gilbn/geometrikks/manifests/";
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const BACKOFF_MS = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 15_000;

export class RegistryError extends Error {}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function lookup(version: string, fetchImpl: typeof fetch): Promise<boolean> {
  const tokenResponse = await fetchImpl(TOKEN_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (tokenResponse.status !== 200) throw new Error(`token request answered ${tokenResponse.status}`);
  const { token } = (await tokenResponse.json()) as { token?: unknown };
  if (typeof token !== "string") throw new Error("token response has no token");

  const manifestResponse = await fetchImpl(`${MANIFEST_URL}${version}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (manifestResponse.status === 200) return true;
  if (manifestResponse.status === 404) return false;
  throw new Error(`manifest request answered ${manifestResponse.status}`);
}

export async function imageExists(
  version: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
    try {
      return await lookup(version, fetchImpl);
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new RegistryError(`ghcr.io lookup for ${version} failed after ${BACKOFF_MS.length + 1} attempts: ${reason}`);
}

export function publishedFromEnv(
  env: Record<string, string | undefined>,
): ((version: string) => Promise<boolean>) | null {
  const raw = env.DOCS_PUBLISHED;
  if (raw === undefined) return null;
  const published = new Set(
    raw
      .split(",")
      .map((version) => version.trim())
      .filter((version) => version !== ""),
  );
  return async (version) => published.has(version);
}
