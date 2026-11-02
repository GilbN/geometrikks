import { OctagonX } from "lucide-react"
import { DropBadge } from "@/components/drop/drop-badge"
import { sblRecordUrl } from "@/lib/drop-lists"
import { useDropNetwork } from "@/lib/queries"
import { POPUP_ROW_ICON_STYLE, PopupRow } from "./PopupCard"

/** The "Listed on" row of a popup about one IP: the DROP pill and the SBL record it links to. Renders nothing for an unlisted IP. */
export function DropPopupRow({ ip }: { ip: string }) {
  const dropNetwork = useDropNetwork(ip)
  if (dropNetwork === null) return null
  return (
    <PopupRow
      label="Listed on"
      icon={<OctagonX style={{ ...POPUP_ROW_ICON_STYLE, color: "var(--destructive)" }} />}
      value={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <DropBadge variant="popup" sblId={dropNetwork.sblId} />
          {dropNetwork.sblId && (
            <a
              href={sblRecordUrl(dropNetwork.sblId)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${dropNetwork.sblId} on check.spamhaus.org`}
              style={{
                fontFamily: "monospace",
                fontSize: "10px",
                color: "var(--popup-fg)",
                textDecoration: "underline dotted",
                textUnderlineOffset: "2px",
              }}
            >
              {dropNetwork.sblId}
            </a>
          )}
        </span>
      }
    />
  )
}
