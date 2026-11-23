import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Options } from "./Options"
import "../styles.css"

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
)
