import { z } from 'zod'

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const safeJsonValue = z.union([jsonPrimitive, z.array(jsonPrimitive)])
export const safeMetadataSchema = z.record(z.string(), safeJsonValue)

export type SafeJsonValue = z.infer<typeof safeJsonValue>
export type SafeMetadata = z.infer<typeof safeMetadataSchema>

export function paginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
	return z.object({
		data: z.array(itemSchema),
		total: z.number().int().min(0),
		limit: z.number().int(),
		offset: z.number().int(),
	})
}
