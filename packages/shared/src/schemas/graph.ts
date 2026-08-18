import { z } from 'zod'
import { objectTypeSchema } from './objects'
import { safeMetadataSchema } from './primitives'

export const graphNodeSchema = z.object({
	$id: z.string().describe('Client-side temporary ID for cross-referencing in edges'),
	type: objectTypeSchema,
	title: z.string().optional(),
	content: z.string().optional(),
	// Optional: bets are always created at `signal` (the founders' go/no-go gate)
	// regardless of what a caller sends — the server ignores this field for bets.
	// Non-bet types still need a status; the graph route returns 400 if omitted.
	status: z.string().optional(),
	metadata: safeMetadataSchema.optional(),
	driver: z.string().uuid().optional(),
})

export const graphEdgeSchema = z.object({
	source: z
		.string()
		.describe('A $id from a node in this request, or a real UUID of an existing object'),
	target: z
		.string()
		.describe('A $id from a node in this request, or a real UUID of an existing object'),
	type: z
		.string()
		.describe('Relationship type: informs, breaks_into, blocks, relates_to, duplicates'),
})

export const createGraphSchema = z.object({
	nodes: z.array(graphNodeSchema).min(1).max(50),
	edges: z.array(graphEdgeSchema).max(100).default([]),
})
