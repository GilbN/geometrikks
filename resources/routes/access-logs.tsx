import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { History, Radio } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AccessLogsTable } from "@/components/access-logs/access-logs-table"
import { LiveTail } from "@/components/access-logs/live-tail"

export const Route = createFileRoute("/access-logs")({
  component: AccessLogsPage,
})

type Mode = "history" | "live"

function AccessLogsPage() {
  const [mode, setMode] = useState<Mode>("history")
  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-end gap-1">
        <Button
          variant={mode === "history" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("history")}
        >
          <History className="h-4 w-4 mr-2" /> History
        </Button>
        <Button
          variant={mode === "live" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("live")}
        >
          <Radio className="h-4 w-4 mr-2" /> Live tail
        </Button>
      </div>
      {mode === "history" ? <AccessLogsTable /> : <LiveTail enabled={mode === "live"} />}
    </div>
  )
}
