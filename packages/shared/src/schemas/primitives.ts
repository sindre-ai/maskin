import { z } from 'zod'

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()])
// Shallowly-nested map of string → string-array — narrowly permitted so
// loop.metadata.closed_statuses ({ [type]: [status, ...] }) can round-trip
// through the write path. The reader in apps/dev/src/routes/loops.ts has
// always expected this shape; the write path rejected it until this entry
// was added. Deeper nesting is still rejected; other value shapes stay flat.
const stringArrayMap = z.record(z.string(), z.array(z.string()))
export const safeJsonValue = z.union([jsonPrimitive, z.array(jsonPrimitive), stringArrayMap])
export const safeMetadataSchema = z.record(z.string(), safeJsonValue)

export type SafeJsonValue = z.infer<typeof safeJsonValue>
export type SafeMetadata = z.infer<typeof safeMetadataSchema>
