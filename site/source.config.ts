import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: `${process.env.DOCS_CONTENT_DIR ?? "content"}/docs`,
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

export default defineConfig();
