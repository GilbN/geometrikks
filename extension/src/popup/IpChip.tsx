import { SrOnlySuffix } from "@/components/sr-only-suffix"
import { decisionLabel } from "@/lib/crowdsec"
import { dropMarkSrText, dropMarkTitle } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"
import { decisionTone, DROP_OUTLINE_CLASS, type IpMark } from "./marks"

/** An IP with the app's marks: the decision fill per type and the dashed DROP outline. */
export function IpChip({
  ip,
  mark,
  className,
}: {
  ip: string
  mark: IpMark | null | undefined
  className?: string
}) {
  const decision = mark?.decisionType ?? null
  const sblId = mark?.dropSblId ?? null
  const decisionTitle = decision === null ? undefined : `Active CrowdSec ${decision} decision`
  const title = sblId === null ? decisionTitle : dropMarkTitle(sblId, decisionTitle)
  return (
    <span
      className={cn(
        "rounded-[5px] px-1.5 py-px font-mono text-xs",
        decision !== null && decisionTone(decision),
        sblId !== null && DROP_OUTLINE_CLASS,
        className,
      )}
      title={title}
    >
      {ip}
      {decision !== null && <SrOnlySuffix text={` (${decisionLabel(decision)})`} />}
      {sblId !== null && <SrOnlySuffix text={dropMarkSrText(sblId)} />}
    </span>
  )
}
