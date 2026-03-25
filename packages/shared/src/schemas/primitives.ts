import { z } from 'zod'

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const safeJsonValue = z.union([jsonPrimitive, z.array(jsonPrimitive)])
export const safeMetadataSchema = z.record(z.string(), safeJsonValue)

export type SafeJsonValue = z.infer<typeof safeJsonValue>
export type SafeMetadata = z.infer<typeof safeMetadataSchema>
