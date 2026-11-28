/**
 * The record a log page shows lives in the URL: `record` names the row and
 * `at` says when it happened. Access log lines and stored raw lines are keyed
 * by id and time, because their tables are stored by time and the time keeps a
 * lookup to one chunk. A Geo Logs row is a location and IP over a range, so
 * `at` there is an ISO 8601 interval. An alert needs only its id.
 *
 * An id is written as a number: the router quotes a string that reads as one.
 */
import { z } from "zod"

export const recordSearchShape = {
  record: z.union([z.number(), z.string()]).optional().catch(undefined),
  at: z.string().optional().catch(undefined),
}

export interface RecordSearch {
  record?: number | string
  at?: string
}

export const NO_RECORD = { record: undefined, at: undefined } satisfies RecordSearch

const POSITIVE_INT = /^[1-9]\d*$/

function positiveId(value: RecordSearch["record"]): number | null {
  if (value === undefined || !POSITIVE_INT.test(String(value))) return null
  return Number.isSafeInteger(Number(value)) ? Number(value) : null
}

function validTime(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value))
}

/** An access log line or a stored raw line. */
export function lineRecord(line: { id: number; at: string }): RecordSearch {
  return { record: line.id, at: line.at }
}

export function parseLineRecord(search: RecordSearch): { id: number; at: string } | null {
  const id = positiveId(search.record)
  return id !== null && validTime(search.at) ? { id, at: search.at } : null
}

export interface GeoRecordKey {
  locationId: number
  ip: string
  from: string
  to: string
}

export function geoRecord(key: GeoRecordKey): RecordSearch {
  return { record: `${key.locationId}@${key.ip}`, at: `${key.from}/${key.to}` }
}

export function parseGeoRecord(search: RecordSearch): GeoRecordKey | null {
  if (typeof search.record !== "string") return null
  const split = search.record.indexOf("@")
  if (split < 1) return null
  const locationId = search.record.slice(0, split)
  const ip = search.record.slice(split + 1)
  const [from, to, ...rest] = search.at?.split("/") ?? []
  if (!POSITIVE_INT.test(locationId) || !ip || rest.length > 0) return null
  if (!validTime(from) || !validTime(to)) return null
  return { locationId: Number(locationId), ip, from, to }
}

export function alertRecord(id: number): RecordSearch {
  return { record: id, at: undefined }
}

export function parseAlertRecord(search: RecordSearch): number | null {
  return positiveId(search.record)
}
