import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { History, Radio } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
      <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
        <TabsList className="pointer-coarse:h-10">
          <TabsTrigger value="history">
            <History className="h-4 w-4" /> History
          </TabsTrigger>
          <TabsTrigger value="live">
            <Radio className="h-4 w-4" /> Live tail
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {mode === "history" ? <AccessLogsTable /> : <LiveTail enabled={mode === "live"} />}
    </div>
  )
}
