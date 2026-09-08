/**
 * Top countries / cities / ASNs by geo-event count for the geo-logs page,
 * with exact unique-IP counts. The switch lives in the frame's tools.
 */
import { useState } from "react"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { dataState } from "@/components/data/types"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AsnCategoryInfo } from "@/components/analytics/asn-category-info"
import { CategoryBadge } from "@/components/analytics/top-asns-table"
import { AsnCell } from "@/components/geo-logs/asn-cell"
import { formatNumber } from "@/lib/api"
import { useGeoLogTopAsns, useGeoLogTopCities, useGeoLogTopCountries } from "@/lib/queries"
import { TablePaginationFooter, usePagedRows } from "@/components/analytics/table-pagination"

type View = "countries" | "cities" | "asns"

export function GeoTopCountriesCities() {
  const [view, setView] = useState<View>("countries")
  const countries = useGeoLogTopCountries({ limit: 25 })
  const cities = useGeoLogTopCities({ limit: 25 })
  const asns = useGeoLogTopAsns({ limit: 25 })
  const { pageItems: countryItems, ...countryPagination } = usePagedRows(countries.data?.items)
  const { pageItems: cityItems, ...cityPagination } = usePagedRows(cities.data?.items)
  const { pageItems: asnItems, ...asnPagination } = usePagedRows(asns.data?.items)

  const active = view === "countries" ? countries : view === "cities" ? cities : asns
  const pagination =
    view === "countries" ? countryPagination : view === "cities" ? cityPagination : asnPagination
  const state = dataState(active.isLoading, active.isError, active.data?.items.length ?? 0)

  return (
    <Tabs value={view} onValueChange={(value) => setView(value as View)}>
      <DataTableFrame
        title="Top locations"
        description="Countries, cities and networks ranked by geo event count."
        count={active.data?.items.length}
        state={state}
        error="Failed to load top locations."
        empty="No geo events match these filters."
        tools={
          <TabsList className="h-8">
            <TabsTrigger value="countries">Countries</TabsTrigger>
            <TabsTrigger value="cities">Cities</TabsTrigger>
            <TabsTrigger value="asns">ASNs</TabsTrigger>
          </TabsList>
        }
        footer={
          pagination.total > pagination.pageSize ? (
            <TablePaginationFooter {...pagination} onPageChange={pagination.setPage} />
          ) : undefined
        }
      >
        {view === "countries" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Country</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="text-right">Unique IPs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {countryItems.map((row) => (
                <TableRow key={row.countryCode}>
                  <TableCell>{row.countryName ?? row.countryCode}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.eventCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.uniqueIps)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : view === "cities" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>City</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="text-right">Unique IPs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cityItems.map((row, index) => (
                <TableRow key={`${row.city}-${row.countryCode}-${index}`}>
                  <TableCell>{row.city}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.eventCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.uniqueIps)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1.5">
                    Category
                    <AsnCategoryInfo />
                  </span>
                </TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="text-right">Unique IPs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {asnItems.map((row) => (
                <TableRow key={row.asn}>
                  <TableCell className="max-w-[260px]">
                    <AsnCell asn={row.asn} organization={row.organization} />
                  </TableCell>
                  <TableCell><CategoryBadge category={row.category} /></TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.eventCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.uniqueIps)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataTableFrame>
    </Tabs>
  )
}
