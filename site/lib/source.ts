import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { NEXT, toUrlSlugs, type VersionPlan } from "./versions";

const latest = process.env.DOCS_LATEST ?? null;
export const plan: VersionPlan = {
  latest,
  pending: [],
  superseded: [],
  served: latest === null ? [NEXT] : [latest, NEXT],
};

const fumadocsSource = docs.toFumadocsSource();
fumadocsSource.files = fumadocsSource.files.filter((file) => plan.served.includes(file.path.split("/")[0]));

export const source = loader({
  baseUrl: "/docs",
  source: fumadocsSource,
  slugs: (_file, next) => toUrlSlugs(next(), plan.latest),
});
