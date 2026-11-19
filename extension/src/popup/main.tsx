import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrandMark } from "@/components/brand/brand-mark"
import { CountryFlag } from "@/components/country-flag"
import { Button } from "@/components/ui/button"
import "../styles.css"

function Popup() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        <BrandMark size={20} variant="small" decorative />
        <span className="font-semibold">GeoMetrikks</span>
      </header>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CountryFlag code="NO" />
        Not connected yet
      </p>
      <Button size="sm" onClick={() => void chrome.runtime.openOptionsPage()}>
        Open options
      </Button>
    </div>
  )
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
)
