import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrandMark } from "@/components/brand/brand-mark"
import { CountryFlag } from "@/components/country-flag"
import { Button } from "@/components/ui/button"
import "../styles.css"

function Options() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <header className="flex items-center gap-2">
        <BrandMark size={24} decorative />
        <h1 className="text-lg font-semibold">GeoMetrikks</h1>
      </header>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CountryFlag code="NO" />
        Connect to your GeoMetrikks server.
      </p>
      <Button className="self-start" disabled>
        Connect
      </Button>
    </main>
  )
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
)
