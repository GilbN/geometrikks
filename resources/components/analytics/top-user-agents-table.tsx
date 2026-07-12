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
import { formatNumber } from "@/lib/api"
import { useTopUserAgents } from "@/lib/queries"

export function TopUserAgentsTable() {
  const { data, isLoading } = useTopUserAgents({ limit: 25 })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top user agents</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User agent</TableHead>
                <TableHead className="text-right">Hits</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((row) => (
                <TableRow key={row.user_agent}>
                  <TableCell className="font-mono text-xs max-w-[640px] truncate">{row.user_agent}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.hits)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
