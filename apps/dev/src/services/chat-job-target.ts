import type { Database } from '@maskin/db'
import { actors, conversations, objects, relationships, sessions } from '@maskin/db/schema'
import { TARGET_OF_RELATIONSHIP_TYPE, TARGET_TYPE } from '@maskin/ext-targets/shared'
import { buildWebAppHref, loopTargetSchema, stripTrailingSlash } from '@maskin/shared'
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'

/** Hard cap on the block, in characters. It rides in every chat, so it stays small. */
export const CHAT_JOB_TARGET_MAX = 2500

const MORE_MARKER = '\n(more targets on the flows you drive)'
const MAX_FLOWS = 3
const MAX_COMPANY_TARGETS = 3
const TITLE_MAX = 80

// Same as chat-drives: a drafted or paused flow is not running.
const LIVE_LOOP_STATUSES = ['learning', 'supervised', 'fully_autonomous']
// Target objects in these statuses are not shown (same as the flows list).
const HIDDEN_TARGET_STATUSES = ['dropped', 'archived']
const IN_LOOP = 'in_loop'
const BREAKS_INTO = 'breaks_into'

export interface ChatJobTargetSession {
	workspaceId: string
	actorId: string
	conversationId: string
}

export interface JobTarget {
	/** Set for a target object, absent for an old row inside a flow. */
	id?: string
	label: string
	actual: number | null
	target: number | null
	ownerName: string | null
	deadline: string | null
	status: string
	/** Title of the company target this flow target serves. */
	servesTitle?: string
}

export interface JobTargetFlow {
	id: string
	title: string
	targets: JobTarget[]
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`
}

const RULES = [
	'## Jobs you are handed',
	'When a person hands you a job (create a webinar, find leads), not a plain question, do this:',
	'1. Before you act, name the target the job serves, where it stands and who owns it. Look in this order: a flow target below (the flow this chat is about, else a flow you drive that fits), then a company target, then neither. If two flows fit, take the one you drive; if still tied, ask once.',
	'2. Do what was asked.',
	'3. Then ask yourself "what\'s next?" and start the follow-up steps that move the target, without asking first. Save the next step on the job with schedule_next_step so it outlives this chat. Never send in a person\'s name, spend money or delete without a decision card.',
	'4. If no target fits, the target has no owner, or there is no follow-up you may do alone: ask once for that setup, name the missing piece, and bring a draft.',
	'A plain factual question gets none of this.',
]

/**
 * The text of the block: the rules, then the targets the lookup can use. Targets
 * are dropped whole lines from the end when it grows past the cap, never cut in half.
 */
export function renderJobTargetBlock(input: {
	flows: JobTargetFlow[]
	companyTargets: JobTarget[]
	workspaceId: string
	frontendUrl: string
}): string {
	const base = stripTrailingSlash(input.frontendUrl)
	const link = (id: string | undefined, title: string) => {
		const text = oneLine(title, TITLE_MAX).replace(/[[\]]/g, '') || 'Untitled'
		return id
			? `[${text}](${buildWebAppHref(base, input.workspaceId, { kind: 'object', id })})`
			: text
	}
	const describe = (t: JobTarget) => {
		const numbers =
			t.actual !== null && t.target !== null
				? `${t.actual} of ${t.target}`
				: t.target !== null
					? `target ${t.target}`
					: 'no number yet'
		return [
			`${link(t.id, t.label)}: ${numbers}`,
			t.status !== 'open' && t.id ? t.status : null,
			t.ownerName ? `owner ${t.ownerName}` : 'no owner',
			t.deadline ? `due ${t.deadline}` : null,
			t.servesTitle ? `serves ${oneLine(t.servesTitle, TITLE_MAX)}` : null,
		]
			.filter(Boolean)
			.join(', ')
	}

	const flowLines = input.flows.flatMap((f) => [
		`- ${link(f.id, f.title)}${f.targets.length ? '' : ': no targets set'}`,
		...f.targets.map((t) => `  - ${describe(t)}`),
	])
	const lines = [
		...RULES,
		'',
		input.flows.length
			? 'Flow targets, as actual of target:'
			: 'No flow target found: you drive no live flow, and this chat is about none.',
		...flowLines,
		input.companyTargets.length
			? 'Company targets (no flow):'
			: 'No company target found, so a job that fits no flow gets the setup request in step 4.',
		...input.companyTargets.map((t) => `- ${describe(t)}`),
	]

	let out = ''
	for (const line of lines) {
		const next = out ? `${out}\n${line}` : line
		if (next.length > CHAT_JOB_TARGET_MAX - MORE_MARKER.length) {
			out = `${out}${MORE_MARKER}`
			break
		}
		out = next
	}
	return `${out}\n\n`
}

type Row = Record<string, unknown>
const dateOf = (meta: unknown): string | null => {
	const d = (meta as Row | null)?.deadline
	return typeof d === 'string' && d ? d.slice(0, 10) : null
}
const numberOf = (meta: unknown, key: string): number | null => {
	const n = (meta as Row | null)?.[key]
	return typeof n === 'number' ? n : null
}

/**
 * The "Jobs you are handed" block for a chat session: the rules for a job a
 * person hands the agent, plus the targets the lookup can use. The flows are
 * the one the chat is about (or the one an object it is about belongs to,
 * through `in_loop`), then the live flows the agent drives. Their targets come
 * from target objects (`target_of`), with the old rows in the flow as the
 * fallback. Company targets are open target objects that belong to no flow.
 */
export async function buildChatJobTargetBlock(
	db: Database,
	session: ChatJobTargetSession,
	frontendUrl: string,
): Promise<string> {
	const flowSelect = { id: objects.id, title: objects.title, metadata: objects.metadata }

	// The flows this job can serve: the chat's subject first.
	const flowRows: Array<{ id: string; title: string | null; metadata: unknown }> = []
	const [convo] = await db
		.select({ subjectId: conversations.subjectId })
		.from(conversations)
		.where(
			and(
				eq(conversations.id, session.conversationId),
				eq(conversations.workspaceId, session.workspaceId),
			),
		)
		.limit(1)
	if (convo?.subjectId) {
		const [subject] = await db
			.select({ ...flowSelect, type: objects.type })
			.from(objects)
			.where(and(eq(objects.id, convo.subjectId), eq(objects.workspaceId, session.workspaceId)))
			.limit(1)
		if (subject?.type === 'loop') {
			flowRows.push(subject)
		} else if (subject) {
			// in_loop: source = flow, target = member object.
			flowRows.push(
				...(await db
					.select(flowSelect)
					.from(relationships)
					.innerJoin(objects, eq(objects.id, relationships.sourceId))
					.where(
						and(
							eq(relationships.type, IN_LOOP),
							eq(relationships.targetId, subject.id),
							eq(objects.workspaceId, session.workspaceId),
							eq(objects.type, 'loop'),
						),
					)
					.limit(MAX_FLOWS)),
			)
		}
	}
	const driven = await db
		.select(flowSelect)
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, session.workspaceId),
				eq(objects.driver, session.actorId),
				eq(objects.type, 'loop'),
				inArray(objects.status, LIVE_LOOP_STATUSES),
			),
		)
		.orderBy(desc(objects.updatedAt))
		.limit(MAX_FLOWS)
	const seen = new Set<string>()
	const flowList = [...flowRows, ...driven]
		.filter((f) => !seen.has(f.id) && seen.add(f.id))
		.slice(0, MAX_FLOWS)

	// Flow targets: target objects first, the old rows where a flow has none.
	const targetRows = flowList.length
		? await db
				.select({
					loopId: relationships.targetId,
					id: objects.id,
					title: objects.title,
					status: objects.status,
					driver: objects.driver,
					metadata: objects.metadata,
				})
				.from(relationships)
				.innerJoin(objects, eq(objects.id, relationships.sourceId))
				.where(
					and(
						eq(relationships.type, TARGET_OF_RELATIONSHIP_TYPE),
						inArray(
							relationships.targetId,
							flowList.map((f) => f.id),
						),
						eq(objects.workspaceId, session.workspaceId),
						eq(objects.type, TARGET_TYPE),
						notInArray(objects.status, HIDDEN_TARGET_STATUSES),
					),
				)
				.orderBy(asc(relationships.createdAt), asc(objects.createdAt))
		: []

	// The company target each flow target serves: breaks_into, source = company target.
	const parents = targetRows.length
		? await db
				.select({ childId: relationships.targetId, title: objects.title })
				.from(relationships)
				.innerJoin(objects, eq(objects.id, relationships.sourceId))
				.where(
					and(
						eq(relationships.type, BREAKS_INTO),
						inArray(
							relationships.targetId,
							targetRows.map((t) => t.id),
						),
						eq(objects.workspaceId, session.workspaceId),
						eq(objects.type, TARGET_TYPE),
					),
				)
		: []

	// Company targets: open target objects that are not the target of any flow.
	const companyRows = await db
		.select({
			id: objects.id,
			title: objects.title,
			status: objects.status,
			driver: objects.driver,
			metadata: objects.metadata,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, session.workspaceId),
				eq(objects.type, TARGET_TYPE),
				eq(objects.status, 'open'),
				sql`not exists (select 1 from ${relationships} where ${relationships.sourceId} = ${objects.id} and ${relationships.type} = ${TARGET_OF_RELATIONSHIP_TYPE})`,
			),
		)
		.orderBy(sql`${objects.metadata}->>'deadline' asc nulls last`)
		.limit(MAX_COMPANY_TARGETS)

	const ownerIds = [
		...new Set([...targetRows, ...companyRows].flatMap((r) => (r.driver ? [r.driver] : []))),
	]
	const owners = ownerIds.length
		? await db
				.select({ id: actors.id, name: actors.name })
				.from(actors)
				.where(inArray(actors.id, ownerIds))
		: []
	const ownerName = (id: string | null) => owners.find((o) => o.id === id)?.name ?? null

	const flows: JobTargetFlow[] = flowList.map((f) => {
		const objectTargets: JobTarget[] = targetRows
			.filter((t) => t.loopId === f.id)
			.map((t) => ({
				id: t.id,
				label: t.title ?? 'Untitled',
				actual: numberOf(t.metadata, 'actual'),
				target: numberOf(t.metadata, 'target'),
				ownerName: ownerName(t.driver),
				deadline: dateOf(t.metadata),
				status: t.status,
				servesTitle: parents.find((p) => p.childId === t.id)?.title ?? undefined,
			}))
		const oldRows = Array.isArray((f.metadata as Row | null)?.targets)
			? ((f.metadata as Row).targets as unknown[])
			: []
		const legacy: JobTarget[] = oldRows.flatMap((row) => {
			const parsed = loopTargetSchema.safeParse(row)
			return parsed.success
				? [
						{
							label: parsed.data.label,
							actual: parsed.data.actual,
							target: parsed.data.target,
							ownerName: parsed.data.ownerActorId ? ownerName(parsed.data.ownerActorId) : null,
							deadline: null,
							status: 'open',
						},
					]
				: []
		})
		return {
			id: f.id,
			title: f.title ?? 'Untitled',
			targets: objectTargets.length ? objectTargets : legacy,
		}
	})

	const companyTargets: JobTarget[] = companyRows.map((t) => ({
		id: t.id,
		label: t.title ?? 'Untitled',
		actual: numberOf(t.metadata, 'actual'),
		target: numberOf(t.metadata, 'target'),
		ownerName: ownerName(t.driver),
		deadline: dateOf(t.metadata),
		status: t.status,
	}))

	return renderJobTargetBlock({
		flows,
		companyTargets,
		workspaceId: session.workspaceId,
		frontendUrl,
	})
}

/**
 * Saves the block on `sessions.config.chat_job_target` as a jsonb merge, first
 * write wins, like `chat_drives`: launch runs again on resume and must not
 * overwrite what the agent was first shown.
 */
export async function saveChatJobTarget(
	db: Database,
	sessionId: string,
	block: string,
): Promise<void> {
	await db
		.update(sessions)
		.set({
			config: sql`coalesce(${sessions.config}, '{}'::jsonb) || ${JSON.stringify({ chat_job_target: block })}::jsonb`,
		})
		.where(
			and(
				eq(sessions.id, sessionId),
				sql`NOT (coalesce(${sessions.config}, '{}'::jsonb) ? 'chat_job_target')`,
			),
		)
}
