/**
 * Decision badge + ban/unban dropdown for one IP. Renders nothing unless the IP is
 * already under a decision or CrowdSec write access is enabled. Shared by MapPopup's
 * top-IPs rows, the banned popup's IP row and the live popup footer - the call sites differ
 * only in layout (an inline icon-only button in a list row vs a bordered
 * footer row with a text label) and in whether a known decision type is
 * available before the banned-IP query resolves.
 *
 * Inline styles keep it visually matched to the popup content. Tailwind does
 * work inside the popups, as the shadcn InspectIpButton next to it shows.
 */
import { Loader2, ShieldBan, ShieldOff } from "lucide-react"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useBanIp, useBannedIps, useCrowdsecStatus, useUnbanIp } from "@/lib/queries"
import { BAN_DURATIONS, crowdsecErrorMessage, resolveDecision } from "@/lib/crowdsec"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"

export function IpBanControls({
  ip,
  initialDecision = null,
  variant = "inline",
  showBadge = true,
  children,
}: {
  ip: string
  /** Rendered between the decision pill and the shield (the inspect button). */
  children?: React.ReactNode
  /** Known decision type before the banned-IP query has loaded; the live
   *  popup has it from its own event data, the banned popup from its lookup. */
  initialDecision?: string | null
  /** "inline": icon-only button for a list row (MapPopup's top-IPs).
   *  "footer": bordered footer row with an icon + Ban/Unban label (LiveRequestPopup). */
  variant?: "inline" | "footer"
  /** Drop the decision pill where the surrounding UI already says so, as the
   *  banned-IPs popup does in its header. */
  showBadge?: boolean
}) {
  const { data: status } = useCrowdsecStatus()
  const { data: bannedIps } = useBannedIps()
  const ban = useBanIp()
  const unban = useUnbanIp()
  const decision = resolveDecision(bannedIps, ip, initialDecision)
  const banned = decision !== null
  const isPending = ban.isPending || unban.isPending

  if (!banned && !status?.writeEnabled) return <>{children}</>

  const isFooter = variant === "footer"
  const Wrapper = isFooter ? "div" : "span"

  return (
    <Wrapper
      style={
        isFooter
          ? {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "8px",
              paddingTop: "8px",
              borderTop: "1px solid var(--popup-border)",
            }
          : { display: "inline-flex", alignItems: "center", gap: "4px" }
      }
    >
      {decision !== null && showBadge && <DecisionBadge type={decision} variant="popup" />}
      {children}
      {status?.writeEnabled && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={isPending}
              title={isFooter ? undefined : banned ? `Unban ${ip}` : `Ban ${ip}`}
              aria-label={banned ? `Unban ${ip}` : `Ban ${ip}`}
              style={
                isFooter
                  ? {
                      marginLeft: "auto",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      background: "transparent",
                      border: "1px solid var(--popup-border)",
                      borderRadius: "4px",
                      padding: "2px 8px",
                      fontSize: "10px",
                      cursor: isPending ? "wait" : "pointer",
                      color: "var(--popup-muted)",
                    }
                  : {
                      display: "inline-flex",
                      alignItems: "center",
                      background: "transparent",
                      border: "none",
                      padding: "2px",
                      cursor: isPending ? "wait" : "pointer",
                      color: isPending ? "var(--primary)" : "var(--popup-muted)",
                    }
              }
            >
              {isPending ? (
                <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
              ) : banned ? (
                <ShieldOff style={{ width: 12, height: 12 }} />
              ) : (
                <ShieldBan style={{ width: 12, height: 12 }} />
              )}
              {isFooter && (banned ? "Unban" : "Ban")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {banned ? (
              <DropdownMenuItem
                onClick={() =>
                  unban.mutate(ip, {
                    onError: (err) =>
                      toast.error(
                        crowdsecErrorMessage(err, `Unban failed for ${ip}; the LAPI may be unreachable.`),
                      ),
                  })
                }
              >
                Unban {ip}
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuLabel>Ban {ip}</DropdownMenuLabel>
                {BAN_DURATIONS.map((d) => (
                  <DropdownMenuItem
                    key={d.value}
                    onClick={() =>
                      ban.mutate(
                        { ip, duration: d.value },
                        {
                          onError: (err) =>
                            toast.error(
                              crowdsecErrorMessage(err, `Ban failed for ${ip}; the LAPI may be unreachable.`),
                            ),
                        },
                      )
                    }
                  >
                    {d.label}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </Wrapper>
  )
}
