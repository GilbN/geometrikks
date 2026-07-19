import { createFileRoute } from "@tanstack/react-router"
import { AboutPage } from "@/components/settings/about-page"

export const Route = createFileRoute("/settings/about")({
  component: AboutPage,
})
