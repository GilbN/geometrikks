/**
 * Top countries / cities by geo-event count for the geo-logs page, with exact
 * unique-IP counts. The Countries/Cities switch lives in the frame's tools.
 */
import { useState } from "react"
import { DataTableFrame } from "@/components/data/data-table-frame"
import { dataState } from "@/components/data/types"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatNumber } from "@/lib/api"
import { useGeoLogTopCities, useGeoLogTopCountries } from "@/lib/queries"
import { TablePaginationFooter, usePagedRows } from "@/components/analytics/table-pagination"

type View = "countries" | "cities"

export function GeoTopCountriesCities() {
  const [view, setView] = useState<View>("countries")
  const countries = useGeoLogTopCountries({ limit: 25 })
  const cities = useGeoLogTopCities({ limit: 25 })
  const { pageItems: countryItems, ...countryPagination } = usePagedRows(countries.data?.items)
  const { pageItems: cityItems, ...cityPagination } = usePagedRows(cities.data?.items)

  const active = view === "countries" ? countries : cities
  const pagination = view === "countries" ? countryPagination : cityPagination
  const state = dataState(active.isLoading, active.isError, active.data?.items.length ?? 0)

  return (
    <Tabs value={view} onValueChange={(value) => setView(value as View)}>
      <DataTableFrame
        title="Top locations"
        description="Countries and cities ranked by geo event count."
        count={active.data?.items.length}
        state={state}
        error="Failed to load top locations."
        empty="No geo events match these filters."
        tools={
          <TabsList className="h-8">
            <TabsTrigger value="countries">Countries</TabsTrigger>
            <TabsTrigger value="cities">Cities</TabsTrigger>
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
        ) : (
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
        )}
      </DataTableFrame>
    </Tabs>
  )
}
