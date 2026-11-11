import { Markdown, type MarkdownProps } from "fumadocs-core/content/md";
import { rehypeCode } from "fumadocs-core/mdx-plugins/rehype-code";
import { remarkGfm } from "fumadocs-core/mdx-plugins/remark-gfm";
import { remarkHeading } from "fumadocs-core/mdx-plugins/remark-heading";
import { getMDXComponents } from "@/components/mdx";
import { openapiFor } from "@/lib/openapi";

export async function ApiIntro({ version }: { version: string }) {
  const schemas = Object.values(await openapiFor(version).getSchemas());
  const intro = schemas[0]?.bundled.info?.description;
  if (!intro) throw new Error(`the ${version} OpenAPI schema has no info.description for the API intro`);

  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkHeading]}
      rehypePlugins={[rehypeCode]}
      components={getMDXComponents() as MarkdownProps["components"]}
    >
      {intro}
    </Markdown>
  );
}
