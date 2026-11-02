import { useId, useRef, useState } from "react"
import { CalendarDays, Check, Copy } from "lucide-react"
import { toast } from "sonner"
import type { CreatedApiKey } from "@/lib/api"
import { useCreateApiKey } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { useNarrowLayout } from "@/components/data/narrow-layout"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  EXPIRY_CHOICES,
  apiErrorMessage,
  apiKeyNameError,
  curlExample,
  expiresAtFor,
  formatKeyDate,
  type ApiKeyScope,
  type ExpiryChoice,
} from "@/components/settings/api-keys-logic"

const SCOPE_CHOICES: { value: ApiKeyScope; title: string; summary: string; detail?: string }[] = [
  {
    value: "read",
    title: "Read",
    summary: "View data and live feeds.",
    detail: "Right for dashboards and monitors.",
  },
  {
    value: "read_write",
    title: "Read/write",
    summary: "Also ban and unban IPs, run scheduler jobs, delete data.",
  },
]

/** Below this host width the form and reveal take the phone layout: shorter copy, full-width buttons. */
const COMPACT_WIDTH = 384

const isExpiryChoice = (value: string): value is ExpiryChoice =>
  EXPIRY_CHOICES.some((expiryChoice) => expiryChoice.value === value)

function startOfToday(): Date {
  const today = new Date()
  return new Date(today.getFullYear(), today.getMonth(), today.getDate())
}

function ExpiryHint({ choice, pickedDate }: { choice: ExpiryChoice; pickedDate: Date | undefined }) {
  if (choice === "never") return <>Never, 30 days, 90 days, 1 year, or a date you pick.</>
  if (choice === "date") return <>{pickedDate ? "It stops working at the end of that day." : "Pick the last day it works."}</>
  return <>Stops working on {formatKeyDate(expiresAtFor(choice, undefined, new Date()) ?? "")}.</>
}

/**
 * The create form, without a title or a frame, so a dialog on a wide screen
 * and a drawer on a phone can both host it. A narrow host gets the phone
 * design: shorter descriptions and one full-width Create button, since the
 * drawer closes on its own.
 */
export function ApiKeyCreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (created: CreatedApiKey) => void
  onCancel: () => void
}) {
  const fieldId = useId()
  const [layoutRef, compact] = useNarrowLayout<HTMLFormElement>(COMPACT_WIDTH)
  const [name, setName] = useState("")
  const [scope, setScope] = useState<ApiKeyScope>("read")
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>("never")
  const [pickedDate, setPickedDate] = useState<Date | undefined>(undefined)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [dateError, setDateError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const createApiKeyMutation = useCreateApiKey()
  const pending = createApiKeyMutation.isPending

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const nextNameError = apiKeyNameError(name)
    const nextDateError = expiryChoice === "date" && !pickedDate ? "Pick a date, or choose another expiry." : null
    setNameError(nextNameError)
    setDateError(nextDateError)
    setServerError(null)
    if (nextNameError) {
      nameInputRef.current?.focus()
      return
    }
    if (nextDateError) return
    createApiKeyMutation.mutate(
      { name: name.trim(), scope, expiresAt: expiresAtFor(expiryChoice, pickedDate, new Date()) },
      {
        onSuccess: onCreated,
        onError: (error) => setServerError(apiErrorMessage(error, "Could not create the key. Try again.")),
      },
    )
  }

  return (
    <form ref={layoutRef} noValidate onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-name`}>Name</Label>
        <Input
          ref={nameInputRef}
          id={`${fieldId}-name`}
          value={name}
          autoComplete="off"
          spellCheck={false}
          placeholder="homepage"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${fieldId}-name-error` : undefined}
          onChange={(event) => {
            setName(event.target.value)
            if (nameError) setNameError(apiKeyNameError(event.target.value))
          }}
        />
        {nameError && <FieldError id={`${fieldId}-name-error`} className="text-xs">{nameError}</FieldError>}
      </div>

      <div className="space-y-1.5">
        <Label id={`${fieldId}-access`}>Access</Label>
        <RadioGroup
          aria-labelledby={`${fieldId}-access`}
          value={scope}
          onValueChange={(value) => setScope(value === "read_write" ? "read_write" : "read")}
          className="gap-1.5"
        >
          {SCOPE_CHOICES.map((scopeChoice) => (
            <FieldLabel key={scopeChoice.value} htmlFor={`${fieldId}-${scopeChoice.value}`} className="w-full">
              <Field orientation="horizontal" className="items-start gap-2.5 px-3! py-2.5!">
                <RadioGroupItem value={scopeChoice.value} id={`${fieldId}-${scopeChoice.value}`} className="mt-0.5" />
                <FieldContent className="gap-0.5">
                  <FieldTitle className="text-[13px]">{scopeChoice.title}</FieldTitle>
                  <FieldDescription className="text-xs">
                    {scopeChoice.summary}
                    {scopeChoice.detail && !compact && ` ${scopeChoice.detail}`}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-expires`}>Expires</Label>
        <div className="flex flex-wrap gap-2">
          <Select
            value={expiryChoice}
            onValueChange={(value) => {
              if (!isExpiryChoice(value)) return
              setExpiryChoice(value)
              setDateError(null)
            }}
          >
            <SelectTrigger id={`${fieldId}-expires`} className="min-w-36 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_CHOICES.map((expiryOption) => (
                <SelectItem key={expiryOption.value} value={expiryOption.value}>
                  {expiryOption.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {expiryChoice === "date" && (
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn("min-w-36 flex-1 justify-start font-normal", !pickedDate && "text-muted-foreground")}
                  aria-invalid={dateError ? true : undefined}
                  aria-describedby={dateError ? `${fieldId}-date-error` : undefined}
                >
                  <CalendarDays />
                  {pickedDate ? formatKeyDate(pickedDate.toISOString()) : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={pickedDate}
                  defaultMonth={pickedDate}
                  disabled={{ before: startOfToday() }}
                  onSelect={(date) => {
                    setPickedDate(date)
                    setDateError(null)
                    if (date) setCalendarOpen(false)
                  }}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>
        {dateError ? (
          <FieldError id={`${fieldId}-date-error`} className="text-xs">{dateError}</FieldError>
        ) : (
          <p className="text-xs text-muted-foreground">
            <ExpiryHint choice={expiryChoice} pickedDate={pickedDate} />
          </p>
        )}
      </div>

      {serverError && <FieldError className="text-xs">{serverError}</FieldError>}

      <div className="flex justify-end gap-2 pt-1">
        {!compact && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" size={compact ? "lg" : "default"} className={cn(compact && "w-full")} disabled={pending}>
          {pending ? "Creating" : "Create"}
        </Button>
      </div>
    </form>
  )
}

function canUseClipboard(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && Boolean(navigator.clipboard)
}

/**
 * The one-time reveal. Without the Clipboard API, as on plain http over a
 * LAN, the key sits in a read-only field that selects itself.
 */
export function ApiKeyReveal({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  const [layoutRef, compact] = useNarrowLayout<HTMLDivElement>(COMPACT_WIDTH)
  const [clipboardAvailable, setClipboardAvailable] = useState(canUseClipboard)
  const [copied, setCopied] = useState(false)
  const keyFieldRef = useRef<HTMLTextAreaElement>(null)
  const copiedTimerRef = useRef<number | undefined>(undefined)

  const selectKey = () => {
    const keyField = keyFieldRef.current
    if (!keyField) return
    keyField.focus()
    keyField.setSelectionRange(0, keyField.value.length)
  }

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(created.key)
    } catch {
      setClipboardAvailable(false)
      toast.error("The browser blocked the copy. Select the key and copy it.")
      return
    }
    setCopied(true)
    window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const example = curlExample(window.location.origin, created.apiKey.displayPrefix)

  return (
    <div ref={layoutRef} className="space-y-3">
      {clipboardAvailable ? (
        <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/[0.07] px-3 py-2.5">
          <code aria-label="API key" className="min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all select-all">
            {created.key}
          </code>
          {!compact && (
            <Button type="button" size="sm" onClick={() => void copyKey()}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            ref={keyFieldRef}
            readOnly
            aria-label="API key"
            rows={2}
            value={created.key}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-0 resize-none border-primary/40 bg-primary/[0.07] font-mono text-[12.5px] leading-relaxed break-all dark:bg-primary/[0.07]"
          />
          <Button type="button" variant="outline" size={compact ? "lg" : "default"} className="w-full" onClick={selectKey}>
            Select the key, then copy it
          </Button>
        </div>
      )}

      <p className="rounded-r-lg border-l-[3px] border-amber-500 bg-amber-500/[0.07] px-3 py-2 text-[12.5px]">
        This is the only time the key is shown. If you lose it, revoke it and create a new one.
      </p>

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>Send it as a bearer token:</p>
        <code className="block rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground break-all">
          {example}
        </code>
      </div>

      <div className={cn("flex gap-2 pt-1", compact ? "flex-col" : "justify-end")}>
        {compact && clipboardAvailable && (
          <Button type="button" size="lg" className="w-full" onClick={() => void copyKey()}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy key"}
          </Button>
        )}
        <Button
          type="button"
          variant={compact ? "outline" : "default"}
          size={compact ? "lg" : "default"}
          className={cn(compact && "w-full")}
          onClick={onDone}
        >
          Done
        </Button>
      </div>
    </div>
  )
}
