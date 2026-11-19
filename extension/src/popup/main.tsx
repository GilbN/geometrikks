import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Popup } from "./Popup"
import "../styles.css"

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <TooltipProvider>
      <Popup />
      <Toaster theme="system" position="top-center" closeButton className="toaster" />
    </TooltipProvider>
  </StrictMode>,
)
