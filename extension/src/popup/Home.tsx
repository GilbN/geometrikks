import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import { ExternalLink, FileText, Search } from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { hostValuesFromUrl } from "../lib/hosts"
import type { RecentLookup } from "../lib/storage"
import { parseSingleIp } from "../lib/ip"
import { accessLogsUrl } from "../lib/links"
import type { PopupSession } from "./open-context"
import { SiteStatsNeedUpdate } from "./Problems"
import { RecentLookups } from "./RecentLookups"
import { SiteStats } from "./SiteStats"
import type { HomeMode } from "./site-stats"

function SearchField({
  autoFocus,
  inputRef,
  onLookup,
  initialText = "",
}: {
  autoFocus: boolean
  inputRef: Ref<HTMLInputElement>
  onLookup: (ip: string) => void
  initialText?: string
}) {
  const [text, setText] = useState(initialText)
  const [invalid, setInvalid] = useState(initialText !== "" && parseSingleIp(initialText) === null)
  const errorId = useId()
  return (
    <div className="grid gap-1">
      <InputGroup className="h-[34px] rounded-lg">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          value={text}
          placeholder="Look up an IP"
          aria-label="Look up an IP"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          className="font-mono text-[13px] placeholder:font-sans"
          onChange={(event) => {
            setText(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            const ip = parseSingleIp(text)
            if (ip === null) {
              setInvalid(true)
            } else {
              setText("")
              onLookup(ip)
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>
            <kbd className="rounded border px-1.5 font-sans text-[10.5px] text-muted-foreground">
              Enter
            </kbd>
          </InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {invalid && (
        <p id={errorId} role="alert" className="px-1 text-xs text-destructive">
          Not an IP address
        </p>
      )}
    </div>
  )
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
    >
      {children}
    </a>
  )
}

/** Search, then site stats or recent lookups, with the footer links. */
export function Home({
  session,
  mode,
  onLookup,
  searchRef: givenSearchRef,
  recent = null,
  decisionTypes = {},
  initialSearch,
}: {
  session: PopupSession
  mode: HomeMode
  onLookup: (ip: string) => void
  /** Lets the popup put focus back in the field after a lookup. */
  searchRef?: RefObject<HTMLInputElement | null>
  /** The recent list a lookup just wrote. */
  recent?: RecentLookup[] | null
  /** Decision types a lookup confirmed after the site stats marked their IPs. */
  decisionTypes?: Record<string, string | null>
  /** Right-clicked text that isn't an IP, shown in the field to fix. */
  initialSearch?: string
}) {
  const [noTraffic, setNoTraffic] = useState(false)
  const hosts = useMemo(() => hostValuesFromUrl(session.ctx.tabUrl), [session.ctx.tabUrl])
  const onNoTraffic = useCallback(() => setNoTraffic(true), [])
  const ownSearchRef = useRef<HTMLInputElement>(null)
  const searchRef = givenSearchRef ?? ownSearchRef
  // Focus on a control that unmounted with the stats card falls back to body;
  // anywhere else, the user put it there.
  useEffect(() => {
    if (!noTraffic) return
    const active = document.activeElement
    if (active === null || active === document.body) searchRef.current?.focus()
  }, [noTraffic])
  const showStats = mode === "site-stats" && hosts !== null && !noTraffic
  const { access, settings, ctx, connection } = session
  const needsUpdate =
    mode === "recent" &&
    !access.hostFilter &&
    settings.showSiteStats &&
    ctx.pendingId === null &&
    hosts !== null
  const { origin } = session.stored

  return (
    <>
      <main className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-auto p-3">
        <SearchField
          autoFocus={!showStats}
          inputRef={searchRef}
          onLookup={onLookup}
          initialText={initialSearch}
        />
        {showStats ? (
          <SiteStats
            session={session}
            hosts={hosts}
            onLookup={onLookup}
            onNoTraffic={onNoTraffic}
            decisionTypes={decisionTypes}
          />
        ) : (
          <>
            {needsUpdate && (
              <SiteStatsNeedUpdate appVersion={connection.appVersion} canWrite={access.write} />
            )}
            <RecentLookups
              session={session}
              noTrafficHost={noTraffic && hosts ? hosts[0] : null}
              onLookup={onLookup}
              latest={recent}
            />
          </>
        )}
      </main>
      <footer className="flex items-center gap-2 border-t px-3 py-2 text-[11.5px]">
        {showStats && (
          <FooterLink href={accessLogsUrl(origin, hosts)}>
            <FileText aria-hidden />
            Access logs for this host
          </FooterLink>
        )}
        <span className="ml-auto" />
        <FooterLink href={origin}>
          <ExternalLink aria-hidden />
          Open GeoMetrikks
        </FooterLink>
      </footer>
    </>
  )
}
