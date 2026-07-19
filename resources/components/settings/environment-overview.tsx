import { useState } from "react"
import { useSystemSettings } from "@/lib/queries"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { SettingFieldView, SettingsSectionView } from "@/generated/api/types.gen"

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "not set"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function isNonDefault(field: SettingFieldView): boolean {
  // default null means dynamic default (default_factory); never emphasize
  if (field.default === null || field.default === undefined) return false
  return JSON.stringify(field.value) !== JSON.stringify(field.default)
}

function ValueCell({ field }: { field: SettingFieldView }) {
  if (field.is_secret) {
    return field.value === null || field.value === undefined ? (
      <Badge variant="outline">not set</Badge>
    ) : (
      <Badge variant="secondary">set (hidden)</Badge>
    )
  }
  return (
    <code
      className={
        isNonDefault(field)
          ? "text-xs font-medium text-foreground"
          : "text-xs text-muted-foreground"
      }
    >
      {formatValue(field.value)}
    </code>
  )
}

function SectionCard({ section }: { section: SettingsSectionView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{section.title}</CardTitle>
        {section.description && (
          <CardDescription>{section.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[45%]">Setting</TableHead>
              <TableHead className="w-[30%]">Value</TableHead>
              <TableHead>Env var</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.fields.map((field) => (
              <TableRow key={field.key}>
                <TableCell className="align-top">
                  <div className="font-medium">{field.key}</div>
                  {field.description && (
                    <div className="text-xs text-muted-foreground max-w-md">
                      {field.description}
                    </div>
                  )}
                </TableCell>
                <TableCell className="align-top break-all">
                  <ValueCell field={field} />
                </TableCell>
                <TableCell className="align-top">
                  <code className="text-xs text-muted-foreground">{field.env_var}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function EnvironmentOverview() {
  const { data, isLoading } = useSystemSettings()
  const [query, setQuery] = useState("")

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const sections = data.sections
    .map((section) => ({
      ...section,
      fields: section.fields.filter(
        (f) =>
          !q ||
          f.key.toLowerCase().includes(q) ||
          f.env_var.toLowerCase().includes(q) ||
          (f.description ?? "").toLowerCase().includes(q),
      ),
    }))
    .filter((section) => section.fields.length > 0)

  return (
    <div className="space-y-4">
      <Input
        placeholder="Filter by name, env var or description..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-sm"
      />
      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No settings match "{query}".</p>
      ) : (
        sections.map((section) => <SectionCard key={section.name} section={section} />)
      )}
    </div>
  )
}
