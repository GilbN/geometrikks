/**
 * Marks an IP on the DROP list with a dashed red outline. A CrowdSec decision
 * is a fill, so a banned DROP IP shows the fill inside the outline. The
 * tooltip names the SBL record and screen readers get a text suffix. A map
 * popup about one IP names the listing in a row instead; see DropPopupRow.
 */
import type { CSSProperties, ReactNode } from "react"
import { dropMarkSrText, dropMarkTitle } from "@/lib/drop-lists"
import { useDropNetwork } from "@/lib/queries"

export const DROP_OUTLINE_CLASS = "outline-[1.5px] outline-dashed outline-destructive -outline-offset-[1.5px]"

/** The popup's IP chip already has a box, so its own edge carries the dashed line instead of a second box inside it. */
const DROP_CHIP_STYLE: CSSProperties = {
  outline: "1px dashed var(--destructive)",
  outlineOffset: "-1px",
}

export function DropMarkSrText({ sblId }: { sblId: string }) {
  return <span className="sr-only">{dropMarkSrText(sblId)}</span>
}

/** An IP chip in a map popup's IP list, with a dashed red edge when the IP is on DROP. */
export function DropPopupCode({ ip, style, children }: { ip: string; style: CSSProperties; children?: ReactNode }) {
  const dropNetwork = useDropNetwork(ip)
  if (dropNetwork === null) return <code style={style}>{children ?? ip}</code>
  return (
    <code style={{ ...style, ...DROP_CHIP_STYLE }} title={dropMarkTitle(dropNetwork.sblId)}>
      {children ?? ip}
      <DropMarkSrText sblId={dropNetwork.sblId} />
    </code>
  )
}
