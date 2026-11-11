import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import versions from "../.generated/versions.json";
import { toUrlSlugs, type VersionPlan } from "./versions";

export const plan = versions as VersionPlan;

const fumadocsSource = docs.toFumadocsSource();
fumadocsSource.files = fumadocsSource.files.filter((file) => plan.served.includes(file.path.split("/")[0]));

export const source = loader({
  baseUrl: "/docs",
  source: fumadocsSource,
  slugs: (_file, next) => toUrlSlugs(next(), plan.latest),
});
