import { ShieldAlert } from "lucide-react"
import { AbuseIpdbBlacklistBadge } from "@/components/abuseipdb/abuseipdb-blacklist-badge"
import { useAbuseIpdbBlacklisted } from "@/lib/queries"
import { POPUP_ROW_ICON_STYLE, PopupRow } from "./PopupCard"

/** The "Listed on" row of a popup about one IP. Renders nothing for an IP AbuseIPDB doesn't list. */
export function AbuseIpdbBlacklistPopupRow({ ip }: { ip: string }) {
  const blacklisted = useAbuseIpdbBlacklisted(ip)
  if (!blacklisted) return null
  return <PopupRow label="Listed on" icon={<ShieldAlert style={POPUP_ROW_ICON_STYLE} />} value={<AbuseIpdbBlacklistBadge />} />
}
