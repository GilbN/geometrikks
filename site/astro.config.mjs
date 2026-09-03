import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

const github = "https://github.com/GilbN/geometrikks";

export default defineConfig({
  site: "https://geometrikks.dev",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "GeoMetrikks",
      description:
        "Your reverse proxy's access log on a live map. nginx, Traefik and Caddy. Self-hosted, one Docker image.",
      customCss: ["./src/styles/docs.css"],
      social: [{ icon: "github", label: "GitHub", href: github }],
      // Pages are generated from the README and docs/, so edits belong there.
      editLink: { baseUrl: `${github}/edit/develop/` },
      expressiveCode: { shiki: { langAlias: { env: "dotenv" } } },
      sidebar: [
        { label: "Get started", items: [{ autogenerate: { directory: "docs/get-started" } }] },
        { label: "Log sources", items: [{ autogenerate: { directory: "docs/sources" } }] },
        { label: "Features", items: [{ autogenerate: { directory: "docs/features" } }] },
        { label: "Operate", items: [{ autogenerate: { directory: "docs/operate" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "docs/reference" } }] },
        { label: "Contribute", items: [{ autogenerate: { directory: "docs/contribute" } }] },
      ],
    }),
    sitemap(),
  ],
  vite: { plugins: [tailwindcss()] },
});
