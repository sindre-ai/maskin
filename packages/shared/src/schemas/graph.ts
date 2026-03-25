import { z } from 'zod'
import { objectTypeSchema } from './objects'

export const graphNodeSchema = z.object({
	$id: z.string().describe('Client-side temporary ID for cross-referencing in edges'),
	type: objectTypeSchema,
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string(),
	metadata: z.record(z.unknown()).optional(),
	owner: z.string().uuid().optional(),
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
