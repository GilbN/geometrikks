import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const FEEDBACK_MS = 2000

let lastMessage = ""

/** Copies the IP. The status bubble sits outside the button because a
 *  button's children are presentational and a live region there is not
 *  reliably announced. */
export function CopyIp({ ip }: { ip: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const [message, setMessage] = useState("")
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const report = (ok: boolean) => {
    clearTimeout(timer.current)
    let text = ok ? "Copied" : "Copy failed"
    // VoiceOver skips a message identical to the one before it.
    if (text === lastMessage) text += " "
    lastMessage = text
    setState(ok ? "copied" : "failed")
    setMessage(text)
    timer.current = setTimeout(() => {
      setState("idle")
      setMessage("")
    }, FEEDBACK_MS)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ip)
      report(true)
    } catch {
      report(false)
    }
  }

  return (
    <span className="relative inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="min-h-6 min-w-6 text-muted-foreground"
        aria-label={`Copy ${ip}`}
        title="Copy"
        data-copied={state === "copied" || undefined}
        data-failed={state === "failed" || undefined}
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check className="text-chart-2" /> : <Copy />}
      </Button>
      <span
        role="status"
        className={cn(
          "text-[11px] transition-opacity motion-reduce:transition-none",
          message ? "opacity-100" : "opacity-0",
          state === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {message}
      </span>
    </span>
  )
}
