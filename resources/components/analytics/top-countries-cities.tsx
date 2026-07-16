import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatNumber } from "@/lib/api"
import { useTopCityStats, useTopCountryStats } from "@/lib/queries"

export function TopCountriesCities() {
  const { data: countryData, isLoading: isCountryLoading } = useTopCountryStats({ limit: 25 })
  const { data: cityData, isLoading: isCityLoading } = useTopCityStats({ limit: 25 })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top Countries / Cities</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="countries">
          <TabsList>
            <TabsTrigger value="countries">Countries</TabsTrigger>
            <TabsTrigger value="cities">Cities</TabsTrigger>
          </TabsList>
          <TabsContent value="countries">
            {isCountryLoading || !countryData ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Country</TableHead>
                    <TableHead className="text-right">Hits</TableHead>
                    <TableHead className="text-right">Unique IPs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {countryData.items.map((row) => (
                    <TableRow key={row.country_code}>
                      <TableCell>{row.country_name ?? row.country_code}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.unique_ips)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
          <TabsContent value="cities">
            {isCityLoading || !cityData ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>City</TableHead>
                    <TableHead className="text-right">Hits</TableHead>
                    <TableHead className="text-right">Unique IPs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cityData.items.map((row, index) => (
                    <TableRow key={`${row.city}-${row.country_code}-${index}`}>
                      <TableCell>{row.city}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.unique_ips)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
