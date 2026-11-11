import type { StructuredData } from "fumadocs-core/mdx-plugins/remark-structure";
import { flexsearchFromSource } from "fumadocs-core/search/flexsearch";
import type { OpenAPIPageData } from "fumadocs-openapi/server";
import { source } from "@/lib/source";
import { versionOfUrl, withSlash } from "@/lib/versions";

type IndexedPage = typeof source.$inferPage | { type: "openapi"; url: string; data: OpenAPIPageData };

export const revalidate = false;

export const { staticGET: GET } = flexsearchFromSource(source, {
  buildIndex(page) {
    const indexed = page as IndexedPage;
    let fields: { title: string; description?: string; structuredData: StructuredData };
    if (indexed.type === "openapi") {
      const { title, description, structuredData } = indexed.data;
      fields = { title: title ?? indexed.url, description, structuredData };
    } else {
      const { title, description, structuredData } = indexed.data;
      fields = { title, description, structuredData };
    }
    return {
      ...fields,
      id: page.url,
      url: withSlash(page.url),
      tag: versionOfUrl(page.url),
    };
  },
});
