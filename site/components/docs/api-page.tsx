"use client";
import { createOpenAPIPage } from "fumadocs-openapi/ui";

export const OpenAPIPage = createOpenAPIPage({
  playground: { enabled: false },
  loadDocument: async (id) => (await import(`../../.generated/openapi/${id}.json`)).default,
});
