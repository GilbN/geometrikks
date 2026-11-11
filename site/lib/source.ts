import { docs } from "collections/server";
import { loader, multiple } from "fumadocs-core/source";
import versions from "../.generated/versions.json";
import { openapiFor, openapiSources } from "./openapi";
import { NEXT, toUrlSlugs, type VersionPlan } from "./versions";

export const plan = versions as VersionPlan;

const fumadocsSource = docs.toFumadocsSource();
fumadocsSource.files = fumadocsSource.files.filter((file) => plan.served.includes(file.path.split("/")[0]));

const openapiFiles = (await openapiSources()).flatMap((openapiSource) => openapiSource.files);

export const source = loader({
  baseUrl: "/docs",
  source: multiple({ docs: fumadocsSource, openapi: { files: openapiFiles } }),
  // One copy only: each registration adds its own method badge to every sidebar entry.
  plugins: [openapiFor(NEXT).loaderPlugin()],
  slugs: (_file, next) => toUrlSlugs(next(), plan.latest),
});
