import { describe, expect, test } from "bun:test";
import { imageExists, publishedFromEnv, RegistryError } from "../scripts/lib/registry";

type Answer = number | "network-error";

function fakeFetch(answers: { token: Answer | Answer[]; manifest?: Answer | Answer[] }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queues = {
    token: Array.isArray(answers.token) ? [...answers.token] : null,
    manifest: Array.isArray(answers.manifest) ? [...answers.manifest] : null,
  };
  const next = (kind: "token" | "manifest"): Answer => {
    const queue = queues[kind];
    if (queue !== null) return queue.length > 1 ? queue.shift()! : queue[0];
    return answers[kind] as Answer;
  };
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const kind = url.startsWith("https://ghcr.io/token") ? "token" : "manifest";
    const answer = next(kind);
    if (answer === "network-error") throw new TypeError("fetch failed");
    if (kind === "token") {
      const body = answer === 200 ? JSON.stringify({ token: "anon-token" }) : "{}";
      return new Response(body, { status: answer });
    }
    return new Response(null, { status: answer });
  };
  return Object.assign(impl as unknown as typeof fetch, { calls });
}

const noSleep = async () => {};

describe("imageExists", () => {
  test("200 means the image is published", async () => {
    await expect(imageExists("0.24.0", fakeFetch({ token: 200, manifest: 200 }), noSleep)).resolves.toBe(true);
  });

  test("404 means it is not", async () => {
    await expect(imageExists("9.9.9", fakeFetch({ token: 200, manifest: 404 }), noSleep)).resolves.toBe(false);
  });

  test("a 5xx that never clears throws RegistryError", async () => {
    await expect(imageExists("0.24.0", fakeFetch({ token: 200, manifest: 503 }), noSleep)).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  test("a network error on the token throws RegistryError", async () => {
    await expect(imageExists("0.24.0", fakeFetch({ token: "network-error" }), noSleep)).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  test("a failed token answer throws RegistryError", async () => {
    await expect(imageExists("0.24.0", fakeFetch({ token: 500, manifest: 200 }), noSleep)).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  test("one 503 then 200 resolves true after a retry", async () => {
    const fetchImpl = fakeFetch({ token: 200, manifest: [503, 200] });
    await expect(imageExists("0.24.0", fetchImpl, noSleep)).resolves.toBe(true);
    expect(fetchImpl.calls.filter((call) => call.url.includes("/manifests/")).length).toBe(2);
  });

  test("four 503s make four manifest calls, then RegistryError", async () => {
    const fetchImpl = fakeFetch({ token: 200, manifest: [503, 503, 503, 503] });
    await expect(imageExists("0.24.0", fetchImpl, noSleep)).rejects.toBeInstanceOf(RegistryError);
    expect(fetchImpl.calls.filter((call) => call.url.includes("/manifests/")).length).toBe(4);
  });

  test("backs off 1 s, 2 s, 4 s between attempts", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await expect(imageExists("0.24.0", fakeFetch({ token: 200, manifest: 502 }), sleep)).rejects.toBeInstanceOf(
      RegistryError,
    );
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  test("asks for an anonymous token, then HEADs the manifest with it", async () => {
    const fetchImpl = fakeFetch({ token: 200, manifest: 200 });
    await imageExists("0.24.0", fetchImpl, noSleep);
    const [token, manifest] = fetchImpl.calls;
    expect(token.url).toBe("https://ghcr.io/token?scope=repository:gilbn/geometrikks:pull&service=ghcr.io");
    expect(manifest.url).toBe("https://ghcr.io/v2/gilbn/geometrikks/manifests/0.24.0");
    expect(manifest.init?.method).toBe("HEAD");
    const headers = new Headers(manifest.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer anon-token");
    expect(headers.get("accept")).toBe(
      "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    );
  });
});

describe("publishedFromEnv", () => {
  test("unset returns null", () => {
    expect(publishedFromEnv({})).toBeNull();
  });

  test("empty means nothing is published", async () => {
    expect(await publishedFromEnv({ DOCS_PUBLISHED: "" })!("0.1.0")).toBe(false);
  });

  test("looks up a comma-separated list", async () => {
    const isPublished = publishedFromEnv({ DOCS_PUBLISHED: "0.1.0, 0.2.0" })!;
    expect(await isPublished("0.1.0")).toBe(true);
    expect(await isPublished("0.2.0")).toBe(true);
    expect(await isPublished("0.3.0")).toBe(false);
  });
});
