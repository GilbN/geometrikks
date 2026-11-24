import { Link } from "@tanstack/react-router"
import {
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  Palette,
  ScrollText,
  Sparkles,
  UserRound,
} from "lucide-react"
import { SiDocker } from "react-icons/si"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { GlowDot } from "@/components/reload-notice"
import { useTheme } from "@/components/theme-provider"
import { DOCS_URL } from "@/lib/docs-links"
import { logOut } from "@/lib/log-out"
import { useChangelogUnseen, useMe, useRuntimeSettings, useUnseenRelease } from "@/lib/queries"
import { parseTheme, THEME_CATALOG } from "@/lib/theme"
import { containerRuntimeLabel, displayVersion, publicVersion } from "@/lib/version"
import { cn } from "@/lib/utils"

const SCHEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const

function AppearanceSubmenu() {
  const { theme, setTheme, colorTheme } = useTheme()
  const scheme = SCHEMES.find((option) => option.value === theme)?.label ?? "System"

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Palette className="text-muted-foreground" />
        Appearance
        <span className="ml-auto pl-2 text-xs whitespace-nowrap text-muted-foreground">
          {THEME_CATALOG[colorTheme].label} · {scheme}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Color scheme
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(parseTheme(value))}
        >
          {SCHEMES.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/appearance">Themes…</Link>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function SidebarUserMenu() {
  const { state, isMobile } = useSidebar()
  const collapsed = !isMobile && state === "collapsed"
  const { data: me } = useMe()
  const { data: settings } = useRuntimeSettings()
  const changelogUnseen = useChangelogUnseen()
  const unseenRelease = useUnseenRelease()

  const session = me?.mode === "session" ? me : null
  const name = session ? session.username : me?.mode === "disabled" ? "Sign-in off" : ""
  const signedInWith = session
    ? session.provider === "oidc"
      ? "Signed in with single sign-on"
      : "Signed in with password"
    : null
  const version = settings ? displayVersion(publicVersion(settings.version)) : null
  const runtimeLabel = settings?.runtime.container
    ? containerRuntimeLabel(settings.runtime.imageTag)
    : null
  const releaseNote = unseenRelease ? `${unseenRelease.displayVersion} is available` : null

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={[name || "User menu", version, releaseNote].filter(Boolean).join(", ")}
              className={cn(
                "h-11 gap-2.5 px-2 bg-sidebar-accent/55 ring-1 ring-inset ring-sidebar-border",
                "data-[state=open]:bg-sidebar-accent",
              )}
            >
              <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-xs font-semibold text-primary">
                {session ? (
                  session.username.charAt(0).toUpperCase()
                ) : (
                  <UserRound className="size-4!" aria-hidden="true" />
                )}
                {changelogUnseen && (
                  <span className="absolute -top-0.5 -right-0.5">
                    <GlowDot />
                  </span>
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] leading-tight font-medium">{name}</span>
                {version && (
                  <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-sidebar-foreground/45">
                    <span className="truncate">{version}</span>
                    {unseenRelease && <GlowDot />}
                  </span>
                )}
              </span>
              <ChevronsUpDown className="ml-auto text-[color:var(--nav-inactive-icon)]" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={collapsed ? "right" : "top"}
            align={collapsed ? "end" : "start"}
            sideOffset={8}
            className="w-58"
          >
            <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
              <span className="font-semibold text-foreground">{name}</span>
              {signedInWith && (
                <span className="text-xs text-muted-foreground">{signedInWith}</span>
              )}
              {runtimeLabel && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <SiDocker aria-hidden="true" className="size-3.5 text-[#2496ED]" />
                  {runtimeLabel}
                </span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <AppearanceSubmenu />
              <DropdownMenuItem asChild>
                <Link to="/settings/changelog">
                  <ScrollText className="text-muted-foreground" />
                  What's new
                  {changelogUnseen && (
                    <span className="ml-auto">
                      <GlowDot />
                    </span>
                  )}
                </Link>
              </DropdownMenuItem>
              {unseenRelease && (
                <DropdownMenuItem asChild>
                  <Link to="/settings/about">
                    <Sparkles className="text-muted-foreground" />
                    {releaseNote}
                    <span className="ml-auto">
                      <GlowDot />
                    </span>
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <a href={DOCS_URL} target="_blank" rel="noreferrer">
                  <ExternalLink className="text-muted-foreground" />
                  Documentation
                </a>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {session && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void logOut()}>
                  <LogOut className="text-muted-foreground" />
                  Log out
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
