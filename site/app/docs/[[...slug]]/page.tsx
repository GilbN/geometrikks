import { createRelativeLink } from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextBanner } from "@/components/docs/NextBanner";
import { getMDXComponents } from "@/components/mdx";
import { plan, source } from "@/lib/source";
import { NEXT, versionOfUrl, withSlash } from "@/lib/versions";

type Props = { params: Promise<{ slug?: string[] }> };

export const dynamicParams = false;

function latestCounterpart(slugs: string[]): string | null {
  if (plan.latest === null) return null;
  const latest = source.getPage(slugs.slice(1));
  return latest ? withSlash(latest.url) : "/docs/";
}

export default async function Page(props: Props) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      {versionOfUrl(page.url) === NEXT && <NextBanner latestHref={latestCounterpart(page.slugs)} />}
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: withSlash(page.url) },
    ...(versionOfUrl(page.url) === NEXT && { robots: { index: false, follow: true } }),
  };
}
