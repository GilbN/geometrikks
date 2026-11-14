import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { createOpenAPI, type OpenAPIServer } from "fumadocs-openapi/server";
import versions from "../.generated/versions.json";
import { withPlaceholderServer } from "./openapi-servers";
import { NEXT, type VersionPlan } from "./versions";

const plan = versions as VersionPlan;
const contentDir = process.env.DOCS_CONTENT_DIR ?? "content";

const schemaLoader = (path: string) => async () => withPlaceholderServer(JSON.parse(await readFile(path, "utf8")));

const servers = new Map<string, OpenAPIServer>([
  [NEXT, createOpenAPI({ input: { [NEXT]: schemaLoader("../resources/generated/openapi.json") } })],
]);
if (plan.latest !== null) {
  servers.set(
    plan.latest,
    createOpenAPI({ input: { [plan.latest]: schemaLoader(`${contentDir}/openapi/${plan.latest}.json`) } }),
  );
}

export function openapiFor(version: string): OpenAPIServer {
  const server = servers.get(version);
  if (!server) throw new Error(`no OpenAPI schema is served for docs version ${version}`);
  return server;
}

const tagSlug = (name: string) => name.replace(/\s+/g, "-").toLowerCase();

async function versionSource(version: string) {
  const server = openapiFor(version);
  const baseDir = `${version}/reference/api`;
  const openapiSource = await server.staticSource({ baseDir, per: "operation", groupBy: "tag", meta: true });
  const tagNames = new Map<string, string>();
  for (const { bundled } of Object.values(await server.getSchemas())) {
    for (const { name } of bundled.tags ?? []) if (name) tagNames.set(tagSlug(name), name);
  }
  // fumadocs-openapi titles a tag folder with idToTitle, which turns "CrowdSec" into "Crowd Sec".
  for (const file of openapiSource.files) {
    if (file.type !== "meta" || posix.dirname(posix.dirname(file.path)) !== baseDir) continue;
    const name = tagNames.get(posix.basename(posix.dirname(file.path)));
    if (name) file.data.title = name;
  }
  return openapiSource;
}

export function openapiSources() {
  return Promise.all([...servers.keys()].map(versionSource));
}
