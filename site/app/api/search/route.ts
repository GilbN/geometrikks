import type { StructuredData } from "fumadocs-core/mdx-plugins/remark-structure";
import { flexsearchFromSource } from "fumadocs-core/search/flexsearch";
import { source } from "@/lib/source";
import { versionOfUrl, withSlash } from "@/lib/versions";

export const revalidate = false;

export const { staticGET: GET } = flexsearchFromSource(source, {
  buildIndex(page) {
    let fields: { title: string; description?: string; structuredData: StructuredData };
    if (page.type === "openapi") {
      const { title, description, structuredData } = page.data;
      fields = { title: title ?? page.url, description, structuredData };
    } else {
      const { title, description, structuredData } = page.data;
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
