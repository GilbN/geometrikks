/**
 * Organization over AS number, the way the analytics Top ASNs table shows
 * them. A dash when the row carries no ASN data.
 */
export function AsnCell({
  asn,
  organization,
}: {
  asn: number | null | undefined
  organization: string | null | undefined
}) {
  if (asn == null) return <span>-</span>
  return (
    <span className="flex flex-col leading-tight">
      <span className="truncate" title={organization ?? undefined}>
        {organization ?? "Unknown"}
      </span>
      <span className="font-mono text-xs text-muted-foreground">AS{asn}</span>
    </span>
  )
}
