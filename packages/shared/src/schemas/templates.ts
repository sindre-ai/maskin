import { z } from 'zod'
import { mcpServerSchema } from './sessions'

// ── Extension template ─────────────────────────────────────────────

const fieldDefinitionTemplateSchema = z.object({
	name: z.string(),
	type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
	required: z.boolean().default(false),
	values: z.array(z.string()).optional(),
})

const objectTypeTemplateSchema = z.object({
	type: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe('Object type identifier (e.g. "lead", "experiment")'),
	display_name: z.string().describe('Human-readable label (e.g. "Lead")'),
	icon: z.string().default('circle').describe('Lucide icon name'),
	statuses: z.array(z.string()).min(1).describe('Valid statuses for this type'),
	fields: z.array(fieldDefinitionTemplateSchema).default([]),
	relationship_types: z.array(z.string()).optional(),
})

const extensionTemplateSchema = z.object({
	id: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe('Extension identifier'),
	name: z.string().describe('Human-readable extension name'),
	object_types: z.array(objectTypeTemplateSchema).min(1),
})

// ── Agent template ─────────────────────────────────────────────────

const agentToolsTemplateSchema = z.object({
	mcpServers: z.record(z.string(), mcpServerSchema).default({}),
})

const agentTemplateSchema = z.object({
	$id: z
		.string()
		.describe('Template-local reference ID for linking triggers to agents (e.g. "standup_agent")'),
	name: z.string().min(1),
	system_prompt: z.string().describe('Agent system prompt defining its behavior'),
	tools: agentToolsTemplateSchema.optional(),
	llm_provider: z.string().default('anthropic'),
	llm_config: z
		.object({
			model: z.string().optional(),
		})
		.optional(),
})

// ── Trigger template ───────────────────────────────────────────────

const cronConfigTemplateSchema = z.object({
	expression: z.string().describe('Standard cron expression (e.g. "0 9 * * *")'),
})

const eventConfigTemplateSchema = z.object({
	entity_type: z.string().describe('Entity type to watch (e.g. "object", "task")'),
	action: z.string().describe('Action to watch (e.g. "created", "updated", "status_changed")'),
	filter: z.record(z.string(), z.unknown()).optional(),
	from_status: z.string().optional(),
	to_status: z.string().optional(),
})

const triggerTemplateSchema = z.discriminatedUnion('type', [
	z.object({
		name: z.string().min(1),
		type: z.literal('cron'),
		config: cronConfigTemplateSchema,
		action_prompt: z.string().min(1).describe('Prompt the agent receives when triggered'),
		target_agent: z
			.string()
			.describe('References an agent $id from the agents array in this template'),
		enabled: z.boolean().default(true),
	}),
	z.object({
		name: z.string().min(1),
		type: z.literal('event'),
		config: eventConfigTemplateSchema,
		action_prompt: z.string().min(1).describe('Prompt the agent receives when triggered'),
		target_agent: z
			.string()
			.describe('References an agent $id from the agents array in this template'),
		enabled: z.boolean().default(true),
	}),
])

// ── Seed data template ─────────────────────────────────────────────

const seedNodeSchema = z.object({
	$id: z.string().describe('Template-local reference ID for linking seed objects via edges'),
	type: z.string().describe('Object type (must be defined in extensions or already exist)'),
	title: z.string().optional(),
	content: z.string().optional(),
	status: z.string(),
	metadata: z.record(z.unknown()).optional(),
})

const seedEdgeSchema = z.object({
	source: z.string().describe('A $id from a seed node in this template'),
	target: z.string().describe('A $id from a seed node in this template'),
	type: z
		.string()
		.describe('Relationship type (e.g. "informs", "breaks_into", "blocks", "relates_to")'),
})

const seedDataSchema = z.object({
	nodes: z.array(seedNodeSchema).default([]),
	edges: z.array(seedEdgeSchema).default([]),
})

// ── Template definition ────────────────────────────────────────────

export const templateSchema = z.object({
	name: z.string().min(1).describe('Template name (e.g. "Product Development")'),
	description: z.string().describe('What this template sets up and who it is for'),
	version: z
		.string()
		.regex(/^\d+\.\d+\.\d+$/)
		.default('1.0.0'),
	extensions: z
		.array(extensionTemplateSchema)
		.default([])
		.describe('Custom extensions to create (object types, statuses, fields)'),
	agents: z
		.array(agentTemplateSchema)
		.default([])
		.describe('Agents to create with system prompts and tool configs'),
	triggers: z
		.array(triggerTemplateSchema)
		.default([])
		.describe('Automation triggers linking events/schedules to agents'),
	seed: seedDataSchema.optional().describe('Initial objects and relationships to create'),
})

export type Template = z.infer<typeof templateSchema>
export type ExtensionTemplate = z.infer<typeof extensionTemplateSchema>
export type AgentTemplate = z.infer<typeof agentTemplateSchema>
export type TriggerTemplate = z.infer<typeof triggerTemplateSchema>
export type SeedData = z.infer<typeof seedDataSchema>

// ── Validation ─────────────────────────────────────────────────────

export interface TemplateValidationError {
	path: string
	message: string
}

/**
 * Validates internal consistency of a template beyond what Zod checks:
 * - Trigger target_agent references must match an agent $id
 * - Seed node types must be defined in extensions or be built-in types
 * - Seed edge source/target must reference seed node $ids
 * - No duplicate $ids across agents or seed nodes
 */
export function validateTemplate(template: Template): TemplateValidationError[] {
	const errors: TemplateValidationError[] = []

	// Collect agent $ids
	const agentIds = new Set<string>()
	for (const agent of template.agents) {
		if (agentIds.has(agent.$id)) {
			errors.push({
				path: 'agents',
				message: `Duplicate agent $id: "${agent.$id}"`,
			})
		}
		agentIds.add(agent.$id)
	}

	// Validate trigger target_agent references
	for (const [i, trigger] of template.triggers.entries()) {
		if (!agentIds.has(trigger.target_agent)) {
			errors.push({
				path: `triggers[${i}].target_agent`,
				message: `Trigger "${trigger.name}" references unknown agent "$id": "${trigger.target_agent}". Available: ${[...agentIds].join(', ') || '(none)'}`,
			})
		}
	}

	// Collect all known object types (built-in + template extensions)
	const knownTypes = new Set(['insight', 'bet', 'task'])
	for (const ext of template.extensions) {
		for (const ot of ext.object_types) {
			knownTypes.add(ot.type)
		}
	}

	// Validate seed data
	if (template.seed) {
		const nodeIds = new Set<string>()
		for (const node of template.seed.nodes) {
			if (nodeIds.has(node.$id)) {
				errors.push({
					path: 'seed.nodes',
					message: `Duplicate seed node $id: "${node.$id}"`,
				})
			}
			nodeIds.add(node.$id)

			if (!knownTypes.has(node.type)) {
				errors.push({
					path: 'seed.nodes',
					message: `Seed node "${node.$id}" uses unknown type "${node.type}". Available: ${[...knownTypes].join(', ')}`,
				})
			}
		}

		for (const [i, edge] of template.seed.edges.entries()) {
			if (!nodeIds.has(edge.source)) {
				errors.push({
					path: `seed.edges[${i}].source`,
					message: `Edge source "${edge.source}" does not match any seed node $id`,
				})
			}
			if (!nodeIds.has(edge.target)) {
				errors.push({
					path: `seed.edges[${i}].target`,
					message: `Edge target "${edge.target}" does not match any seed node $id`,
				})
			}
		}
	}

	return errors
}
