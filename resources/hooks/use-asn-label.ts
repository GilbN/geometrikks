import { useCallback, useMemo } from "react"

interface AsnWithOrganization {
  asn: number
  organization?: string | null
}

/** Labels an ASN as "AS13335 Cloudflare, Inc." when the facets name it, "AS13335" otherwise. */
export function useAsnLabel(asns: readonly AsnWithOrganization[] | undefined) {
  // FilterCombobox calls labelFor per option per keystroke; a linear find
  // over an unbounded ASN facet list would make that quadratic.
  const organizations = useMemo(
    () => new Map(asns?.map((facet) => [facet.asn, facet.organization]) ?? []),
    [asns],
  )
  return useCallback(
    (asn: number) => {
      const organization = organizations.get(asn)
      return organization ? `AS${asn} ${organization}` : `AS${asn}`
    },
    [organizations],
  )
}
