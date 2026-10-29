/**
 * A menu of one or more radio groups: a dropdown from md up, and a bottom
 * drawer with full-width rows on phones, like the time range and IP action
 * drawers. With one group a pick closes the menu. With several the drawer
 * stays open until Done, so each group can be set in one visit.
 */
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

export interface RadioMenuOption {
  value: string
  label: string
  /** A second line under the label. */
  hint?: string
}

export interface RadioMenuGroup {
  label: string
  value: string
  options: readonly RadioMenuOption[]
  onValueChange: (value: string) => void
  /** Shown instead of the options, e.g. when there is only one choice. */
  note?: string
  /** Lay dropdown items out as a column, for a group whose options have hints. */
  stacked?: boolean
}

export function ResponsiveRadioMenu({
  title,
  description,
  trigger,
  groups,
  align = "end",
  contentClassName,
}: {
  /** Drawer title on phones. */
  title: string
  /** Screen-reader description of the drawer. */
  description: string
  trigger: React.ReactNode
  groups: readonly RadioMenuGroup[]
  align?: "start" | "end"
  contentClassName?: string
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const idPrefix = useId()
  const single = groups.length === 1
  // Radix selects a radio on arrow keys by clicking it, which would close a
  // single-group drawer while the user is still stepping through.
  const arrowKeyRef = useRef(false)
  // A drawer left open when the layout turned wide would reopen on its own
  // when it turned narrow again (a phone rotated and back).
  useEffect(() => {
    if (!isMobile) setOpen(false)
  }, [isMobile])

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription className="sr-only">{description}</DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-6">
            {groups.map((group, index) => {
              const labelId = `${idPrefix}-${index}`
              return (
                <section key={group.label} className="flex flex-col gap-1">
                  {!single && (
                    <h3 id={labelId} className="text-xs font-medium text-muted-foreground">
                      {group.label}
                    </h3>
                  )}
                  {group.note ? (
                    <p className="text-sm text-muted-foreground">{group.note}</p>
                  ) : (
                    <RadioGroup
                      aria-labelledby={single ? undefined : labelId}
                      aria-label={single ? group.label : undefined}
                      value={group.value}
                      onValueChange={group.onValueChange}
                      onKeyDown={(event) => {
                        arrowKeyRef.current = event.key.startsWith("Arrow")
                      }}
                      onPointerDown={() => {
                        arrowKeyRef.current = false
                      }}
                      className="gap-0"
                    >
                      {group.options.map((option) => (
                        <label
                          key={option.value}
                          // Closes on a click rather than on a value change, so
                          // arrow keys can move through the choices and a tap on
                          // the current one still closes the drawer.
                          onClick={
                            single
                              ? () => {
                                  if (arrowKeyRef.current) arrowKeyRef.current = false
                                  else setOpen(false)
                                }
                              : undefined
                          }
                          className="flex min-h-13 items-center gap-3 border-b border-border/40 text-sm last:border-b-0"
                        >
                          <RadioGroupItem value={option.value} />
                          <span className="flex flex-col py-2">
                            {option.label}
                            {option.hint && <span className="text-xs text-muted-foreground">{option.hint}</span>}
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  )}
                </section>
              )
            })}
          </div>
          {!single && (
            <DrawerFooter className="pt-0">
              <DrawerClose asChild>
                <Button>Done</Button>
              </DrawerClose>
            </DrawerFooter>
          )}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={contentClassName}>
        {groups.map((group, index) => {
          const labelId = `${idPrefix}-${index}`
          return (
            <div key={group.label}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel id={labelId}>{group.label}</DropdownMenuLabel>
              {group.note ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{group.note}</p>
              ) : (
                <DropdownMenuRadioGroup aria-labelledby={labelId} value={group.value} onValueChange={group.onValueChange}>
                  {group.options.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                      className={cn(group.stacked && "flex-col items-start gap-0")}
                    >
                      {option.label}
                      {option.hint && <span className="text-xs text-muted-foreground">{option.hint}</span>}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              )}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
