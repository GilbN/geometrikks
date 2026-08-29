/**
 * Ban badge + ban/unban dropdown for one IP. Renders nothing unless the IP is
 * already banned or CrowdSec write access is enabled. Shared by MapPopup's
 * top-IPs rows and LiveRequestPopup's request footer - the two call sites
 * differ only in layout (an inline icon-only button in a list row vs a
 * bordered footer row with a text label) and in whether a known banned
 * state is available before the banned-IP query resolves.
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
import { BAN_DURATIONS, crowdsecErrorMessage } from "@/lib/crowdsec"

export function IpBanControls({
  ip,
  initialBanned = false,
  variant = "inline",
  children,
}: {
  ip: string
  /** Rendered between the banned pill and the shield (the inspect button). */
  children?: React.ReactNode
  /** Known banned state before the banned-IP query has loaded; only the
   *  live popup has this from its own event data. */
  initialBanned?: boolean
  /** "inline": icon-only button for a list row (MapPopup's top-IPs).
   *  "footer": bordered footer row with an icon + Ban/Unban label (LiveRequestPopup). */
  variant?: "inline" | "footer"
}) {
  const { data: status } = useCrowdsecStatus()
  const { data: bannedIps } = useBannedIps()
  const ban = useBanIp()
  const unban = useUnbanIp()
  const banned = bannedIps?.has(ip) ?? initialBanned
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
      {banned && (
        <span
          style={{
            fontSize: "9px",
            fontWeight: 600,
            textTransform: "uppercase",
            color: "var(--destructive)",
            background: "color-mix(in oklab, var(--destructive) 15%, transparent)",
            padding: isFooter ? "1px 6px" : "1px 5px",
            borderRadius: "9999px",
          }}
        >
          banned
        </span>
      )}
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
