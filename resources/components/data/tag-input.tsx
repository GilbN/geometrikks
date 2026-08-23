import { useState } from "react"
import { Ban, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * Enter-to-add text input for list filters (IPs, hosts). Holds the draft
 * locally and hands the committed value to `onAdd`; `validate` blocks commits
 * and marks the field invalid while the draft fails. A return-key hint shows
 * once there is something to commit, so the placeholder can be an example
 * value instead of an instruction.
 */
export function TagInput({
  onAdd,
  validate,
  placeholder,
  exclude = false,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onKeyDown"> & {
  onAdd: (value: string) => void
  validate?: (value: string) => boolean
  exclude?: boolean
}) {
  const [draft, setDraft] = useState("")
  const value = draft.trim()
  const invalid = value !== "" && validate !== undefined && !validate(value)

  return (
    <div className={cn("relative min-w-0", className)}>
      {exclude && (
        <Ban
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-destructive/70"
        />
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return
          e.preventDefault()
          if (!value || invalid) return
          onAdd(value)
          setDraft("")
        }}
        placeholder={placeholder}
        aria-invalid={invalid}
        className={cn("h-8 w-full font-mono text-xs", exclude && "pl-7", value && "pr-7")}
        {...props}
      />
      {value && (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-[10px] text-muted-foreground"
        >
          {invalid ? "" : "↵"}
        </kbd>
      )}
    </div>
  )
}

/** Committed list-filter value with a remove button; `exclude` draws it as a negative. */
export function FilterChip({
  value,
  exclude = false,
  onRemove,
}: {
  value: string
  exclude?: boolean
  onRemove: () => void
}) {
  return (
    <Badge
      variant={exclude ? "outline" : "secondary"}
      className={cn("font-mono", exclude && "border-destructive/50 text-destructive")}
    >
      {exclude && <Ban className="size-3" />}
      {value}
      <button
        type="button"
        onClick={onRemove}
        aria-label={exclude ? `Remove exclusion ${value}` : `Remove ${value}`}
        className={cn("ml-1 rounded-full", exclude ? "hover:opacity-70" : "hover:text-destructive")}
      >
        <X className="size-3" />
      </button>
    </Badge>
  )
}
