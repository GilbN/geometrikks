import type { Plugin } from "vite"
import { themeHead } from "./theme-bootstrap.ts"

/** Litestar uses Vite's HTML transform in dev and the built HTML in production. */
export function themeHtml(): Plugin {
  return {
    name: "geometrikks-theme-html",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("<!-- theme-head -->", themeHead()),
    },
  }
}
