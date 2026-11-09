import { OctagonX } from "lucide-react"
import { DropBadge } from "@/components/drop/drop-badge"
import { useDropNetwork } from "@/lib/queries"
import { POPUP_ROW_ICON_STYLE, PopupRow } from "./PopupCard"

/** The "Listed on" row of a popup about one IP: the DROP badge the IP inspector shows, with its SBL record linked. Renders nothing for an unlisted IP. */
export function DropPopupRow({ ip }: { ip: string }) {
  const dropNetwork = useDropNetwork(ip)
  if (dropNetwork === null) return null
  return (
    <PopupRow
      label="Listed on"
      icon={<OctagonX style={POPUP_ROW_ICON_STYLE} />}
      value={<DropBadge variant="long" sblId={dropNetwork.sblId} linked />}
    />
  )
}
