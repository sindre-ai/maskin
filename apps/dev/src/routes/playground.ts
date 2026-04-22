import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	objects,
	relationships,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// Simple in-memory rate limiter by IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 10 // 10 provisions per hour per IP

function checkRateLimit(ip: string): boolean {
	const now = Date.now()
	const entry = rateLimitMap.get(ip)

	if (!entry || now > entry.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
		return true
	}

	if (entry.count >= RATE_LIMIT_MAX) {
		return false
	}

	entry.count++
	return true
}

// Clean up stale entries every 10 minutes
setInterval(
	() => {
		const now = Date.now()
		for (const [ip, entry] of rateLimitMap) {
			if (now > entry.resetAt) {
				rateLimitMap.delete(ip)
			}
		}
	},
	10 * 60 * 1000,
)

const provisionResponseSchema = z.object({
	api_key: z.string(),
	actor: z.object({
		id: z.string().uuid(),
		name: z.string(),
		type: z.string(),
		email: z.string().nullable(),
	}),
	workspace_id: z.string().uuid(),
})

const provisionRoute = createRoute({
	method: 'post',
	path: '/provision',
	tags: ['Playground'],
	summary: 'Provision a playground workspace with demo data',
	description:
		'Creates a temporary actor, workspace, and seeds example data for exploring Maskin without signup.',
	responses: {
		201: {
			content: { 'application/json': { schema: provisionResponseSchema } },
			description: 'Playground provisioned',
		},
		429: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Rate limit exceeded',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

app.openapi(provisionRoute, async (c) => {
	const ip =
		c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown'

	if (!checkRateLimit(ip)) {
		return c.json(
			createApiError('BAD_REQUEST', 'Too many playground provisions. Please try again later.'),
			429,
		)
	}

	const db = c.get('db')

	try {
		// 1. Create playground actor
		const { key } = generateApiKey()
		const [actor] = await db
			.insert(actors)
			.values({
				type: 'human',
				name: 'Playground Explorer',
				apiKey: key,
			})
			.returning()

		if (!actor) {
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to create playground actor'), 500)
		}

		// 2. Create workspace with default settings
		const settings = workspaceSettingsSchema.parse({})
		const [workspace] = await db
			.insert(workspaces)
			.values({
				name: 'Playground Workspace',
				settings,
				createdBy: actor.id,
			})
			.returning()

		if (!workspace) {
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to create playground workspace'), 500)
		}

		await db.insert(workspaceMembers).values({
			workspaceId: workspace.id,
			actorId: actor.id,
			role: 'owner',
		})

		// 3. Create an example agent actor
		const { key: agentKey } = generateApiKey()
		const [agentActor] = await db
			.insert(actors)
			.values({
				type: 'agent',
				name: 'Research Agent',
				apiKey: agentKey,
				systemPrompt:
					'You are a research agent that analyzes signals and produces structured insights for the team.',
			})
			.returning()

		if (agentActor) {
			await db.insert(workspaceMembers).values({
				workspaceId: workspace.id,
				actorId: agentActor.id,
				role: 'member',
			})
		}

		// 4. Seed example objects — insights, bets, tasks
		const createdById = agentActor?.id ?? actor.id

		const [insight1] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'insight',
				title: 'Competitors are shipping AI-powered onboarding flows',
				content:
					'Three major competitors launched AI-assisted onboarding in the last month. Early data shows 40% reduction in time-to-value for new users. This is becoming table stakes.',
				status: 'processing',
				createdBy: createdById,
			})
			.returning()

		const [insight2] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'insight',
				title: 'Support tickets about setup complexity up 60%',
				content:
					'Analysis of last 30 days of support tickets shows a 60% increase in questions about initial setup and configuration. Top complaints: too many steps, unclear documentation, Docker requirement.',
				status: 'clustered',
				createdBy: createdById,
			})
			.returning()

		const [insight3] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'insight',
				title: 'Power users requesting API-first workspace templates',
				content:
					'Several power users in the community have asked for pre-built workspace templates they can deploy via API. They want to automate workspace provisioning for their teams.',
				status: 'new',
				createdBy: createdById,
			})
			.returning()

		const [bet1] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'bet',
				title: 'Simplify onboarding to under 2 minutes',
				content:
					'**Hypothesis:** If we reduce onboarding from 8 steps to 3, and add an interactive wizard, we can get 80% of new users to their first "aha moment" in under 2 minutes.\n\n**Success criteria:**\n- Time to first workspace < 2 minutes\n- Setup completion rate > 80%\n- Support tickets about setup drop by 50%',
				status: 'active',
				owner: actor.id,
				createdBy: actor.id,
			})
			.returning()

		const [bet2] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'bet',
				title: 'Launch workspace templates marketplace',
				content:
					'**Hypothesis:** If we offer pre-built workspace templates for common use cases (product management, engineering, research), new users will reach value faster and power users will share their setups.\n\n**Success criteria:**\n- 5+ templates available at launch\n- 30% of new workspaces use a template\n- Community contributes 3+ templates in first month',
				status: 'proposed',
				createdBy: actor.id,
			})
			.returning()

		const [task1] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'task',
				title: 'Design interactive setup wizard',
				content:
					'Create a step-by-step wizard that guides users through workspace creation, agent configuration, and first trigger setup. Should feel like a conversation, not a form.',
				status: 'in_progress',
				owner: actor.id,
				createdBy: actor.id,
			})
			.returning()

		const [task2] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'task',
				title: 'Write one-command install script',
				content:
					'Create a `curl | bash` style install script that handles Docker check, pulls the image, runs migrations, and starts the server. Should work on macOS and Linux.',
				status: 'done',
				createdBy: createdById,
			})
			.returning()

		const [task3] = await db
			.insert(objects)
			.values({
				workspaceId: workspace.id,
				type: 'task',
				title: 'Build agent configuration UI',
				content:
					'Add a visual editor for configuring agent system prompts, MCP tools, and trigger conditions. Should preview the agent behavior before saving.',
				status: 'todo',
				createdBy: actor.id,
			})
			.returning()

		// 5. Create relationships between objects
		const rels: {
			sourceType: string
			sourceId: string
			targetType: string
			targetId: string
			type: string
		}[] = []

		if (insight1 && bet1) {
			rels.push({
				sourceType: 'insight',
				sourceId: insight1.id,
				targetType: 'bet',
				targetId: bet1.id,
				type: 'informs',
			})
		}
		if (insight2 && bet1) {
			rels.push({
				sourceType: 'insight',
				sourceId: insight2.id,
				targetType: 'bet',
				targetId: bet1.id,
				type: 'informs',
			})
		}
		if (insight3 && bet2) {
			rels.push({
				sourceType: 'insight',
				sourceId: insight3.id,
				targetType: 'bet',
				targetId: bet2.id,
				type: 'informs',
			})
		}
		if (bet1 && task1) {
			rels.push({
				sourceType: 'bet',
				sourceId: bet1.id,
				targetType: 'task',
				targetId: task1.id,
				type: 'breaks_into',
			})
		}
		if (bet1 && task2) {
			rels.push({
				sourceType: 'bet',
				sourceId: bet1.id,
				targetType: 'task',
				targetId: task2.id,
				type: 'breaks_into',
			})
		}
		if (bet2 && task3) {
			rels.push({
				sourceType: 'bet',
				sourceId: bet2.id,
				targetType: 'task',
				targetId: task3.id,
				type: 'breaks_into',
			})
		}

		for (const rel of rels) {
			await db.insert(relationships).values({
				...rel,
				createdBy: actor.id,
			})
		}

		// 6. Log events for the seed data
		const allObjects = [insight1, insight2, insight3, bet1, bet2, task1, task2, task3].filter(
			Boolean,
		)
		for (const obj of allObjects) {
			if (obj) {
				await db.insert(events).values({
					workspaceId: workspace.id,
					actorId: obj.createdBy,
					action: 'created',
					entityType: obj.type,
					entityId: obj.id,
					data: obj,
				})
			}
		}

		logger.info('Playground provisioned', {
			actorId: actor.id,
			workspaceId: workspace.id,
			ip,
		})

		return c.json(
			{
				api_key: key,
				actor: {
					id: actor.id,
					name: actor.name,
					type: actor.type,
					email: actor.email,
				},
				workspace_id: workspace.id,
			} as z.infer<typeof provisionResponseSchema>,
			201,
		)
	} catch (err) {
		logger.error('Playground provision failed', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to provision playground'), 500)
	}
})

export default app
