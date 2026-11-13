/**
 * Mobile filter host: a compact "Filters (n)" trigger opening a drawer, from
 * the bottom or from the right on a phone held sideways. List filters go in
 * FilterSections of FilterListRows. A row with a long list opens a search
 * page here, in place of the rows, instead of nesting a second drawer.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { SideDrawerClose } from "@/components/map/SideDrawer"
import { usePhoneDrawer } from "@/hooks/use-phone-drawer"
import { cn } from "@/lib/utils"

interface FilterPages {
  activeId: string | null
  host: HTMLElement | null
  open: (id: string, title: string) => void
}

const FilterPagesContext = createContext<FilterPages | null>(null)

export const useFilterPages = () => useContext(FilterPagesContext)

export const FilterPagesProvider = FilterPagesContext.Provider

/**
 * Search pages for a drawer that holds FilterListRows. Put its rows in a
 * FilterPagesProvider, hide them while `page` is set, and render a
 * FilterPageBack and a FilterPageHost.
 */
export function useFilterPageState() {
  const [page, setPage] = useState<{ id: string; title: string } | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const pageOpener = useRef<HTMLElement | null>(null)

  const pages = useMemo<FilterPages>(() => ({
    activeId: page?.id ?? null,
    host,
    open: (id, title) => {
      pageOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPage({ id, title })
    },
  }), [page, host])

  // Each view hides the control that had focus, which would drop it to the body.
  useLayoutEffect(() => {
    if (page) {
      backButton.current?.focus({ preventScroll: true })
    } else {
      pageOpener.current?.focus({ preventScroll: true })
      pageOpener.current = null
    }
  }, [page])

  const back = useCallback(() => setPage(null), [])
  // Refocusing the row would pull focus back into the closing drawer.
  const reset = useCallback(() => {
    setPage(null)
    pageOpener.current = null
  }, [])

  return { page, pages, backButton, setHost, back, reset }
}

type FilterPageState = ReturnType<typeof useFilterPageState>

export function FilterPageBack({ state, label }: { state: FilterPageState; label: string }) {
  return (
    <Button ref={state.backButton} variant="ghost" size="sm" className="-ml-2 text-primary pointer-coarse:h-11" onClick={state.back}>
      <ChevronLeft className="size-4" />
      {label}
    </Button>
  )
}

export function FilterPageHost({ state }: { state: FilterPageState }) {
  return <div ref={state.setHost} className={state.page ? "flex min-h-0 grow shrink basis-[70vh] flex-col px-4 pb-6" : "hidden"} />
}

export function FiltersDrawer({
  activeCount,
  onClear,
  children,
}: {
  activeCount: number
  onClear?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const pageState = useFilterPageState()
  const { page } = pageState

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) pageState.reset()
  }
  const drawer = usePhoneDrawer("filters", open, () => changeOpen(false))

  return (
    <Drawer key={drawer.key} direction={drawer.direction} open={drawer.open} onOpenChange={changeOpen} onClosed={drawer.onClosed}>
      <DrawerTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 pointer-coarse:h-11">
          <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
          Filters
          {activeCount > 0 && (
            <>
              {" "}
              <span className="sr-only">, active filter groups:</span>({activeCount})
            </>
          )}
        </Button>
      </DrawerTrigger>
      <DrawerContent className={drawer.contentClassName}>
        <DrawerHeader className="flex-row items-center justify-between">
          {page ? <FilterPageBack state={pageState} label="Filters" /> : null}
          <div className={drawer.side && !page ? "mr-auto" : undefined}>
            <DrawerTitle>{page?.title ?? "Filters"}</DrawerTitle>
            <DrawerDescription className="sr-only">
              Adjust the table filters.
            </DrawerDescription>
          </div>
          {!page && onClear && activeCount > 0 && (
            <Button variant="ghost" size="sm" className="text-muted-foreground pointer-coarse:h-11" onClick={onClear}>
              Clear filters
            </Button>
          )}
          {drawer.side && <SideDrawerClose />}
        </DrawerHeader>
        <FilterPagesProvider value={pageState.pages}>
          <div className={cn("flex flex-col gap-2.5 overflow-y-auto overscroll-contain px-4 pb-6 *:shrink-0", page && "hidden")}>
            {children}
          </div>
        </FilterPagesProvider>
        <FilterPageHost state={pageState} />
      </DrawerContent>
    </Drawer>
  )
}
