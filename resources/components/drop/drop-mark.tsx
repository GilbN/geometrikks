/**
 * Marks an IP on the DROP list with a dashed red underline. A CrowdSec
 * decision is a fill, so a banned DROP IP shows both. The tooltip names the
 * SBL record and screen readers get a text suffix.
 */
import type { CSSProperties, ReactNode } from "react"
import { dropMarkSrText, dropMarkTitle } from "@/lib/drop-lists"
import { useDropNetwork } from "@/lib/queries"

export const DROP_UNDERLINE_CLASS =
  "underline decoration-dashed decoration-destructive decoration-2 underline-offset-2 pb-0.5"

const DROP_UNDERLINE_STYLE: CSSProperties = {
  textDecorationLine: "underline",
  textDecorationStyle: "dashed",
  textDecorationColor: "var(--destructive)",
  textDecorationThickness: "1.5px",
  textUnderlineOffset: "3px",
}

export function DropMarkSrText({ sblId }: { sblId: string }) {
  return <span className="sr-only">{dropMarkSrText(sblId)}</span>
}

/** An IP inside a map popup, which styles inline rather than through utility classes. */
export function DropPopupIp({ ip, children }: { ip: string; children?: ReactNode }) {
  const dropNetwork = useDropNetwork(ip)
  if (dropNetwork === null) return <>{children ?? ip}</>
  return (
    <span style={DROP_UNDERLINE_STYLE} title={dropMarkTitle(dropNetwork.sblId)}>
      {children ?? ip}
      <DropMarkSrText sblId={dropNetwork.sblId} />
    </span>
  )
}
