import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Popup } from "./Popup"
import "../styles.css"

const TOAST_BOTTOM = 60

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <TooltipProvider>
      <Popup />
      <Toaster
        theme="system"
        position="bottom-center"
        offset={{ bottom: TOAST_BOTTOM }}
        mobileOffset={{ bottom: TOAST_BOTTOM, left: 12, right: 12 }}
        closeButton
        className="toaster"
      />
    </TooltipProvider>
  </StrictMode>,
)
