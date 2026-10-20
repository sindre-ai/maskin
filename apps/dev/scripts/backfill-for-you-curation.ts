// One-workspace backfill for the Chief of Staff's For You curation and its
// "Questions from other agents" relay (PRs #2183 and #2264).
//
// New workspaces get all of this from the seed templates. An existing workspace
// does not: its Chief of Staff actor keeps the system prompt it was created
// with, its for-you-format skill keeps its old text, and bootstrap never adds
// the hourly "For You — curate the list" trigger to a workspace that was
// bootstrapped before it existed. Until this runs, GET /api/for-you returns an
// empty list for that workspace, because nothing writes the for_you
// notifications it reads.
//
// What it changes, and nothing else:
//   1. The Chief of Staff's system prompt: replaces its "# For You feed" (or
//      "# For You list") section and adds "# Questions from other agents".
//      Every other section is left exactly as stored, so a prompt the owner
//      customised keeps its customisations.
//   2. The for-you-format skill, but only while it still carries the old
//      opening line. A skill that was edited by hand is reported and skipped.
//   3. The "For You — curate the list" trigger, created if the workspace has no
//      trigger of that name. It is a cron that starts a Chief of Staff session
//      every hour, so it costs real usage: check the workspace is one that
//      should pay for that before applying.
//
// Scope (Magnus 2026-09-02): backfills are per workspace, not --all. Other
// workspaces catch the new template on their next agent-template update.
//
// Run (dry run by default, prints the plan and writes nothing):
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-for-you-curation.ts --workspace-id=<uuid>
//   DATABASE_URL=... S3_ENDPOINT=... pnpm --filter @maskin/dev exec tsx scripts/backfill-for-you-curation.ts --workspace-id=<uuid> --apply
//
// Idempotent: a second run reports "none" for all three and writes nothing.

import { pathToFileURL } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import { actors, triggers, workspaceMembers, workspaceSkills, workspaces } from '@maskin/db/schema'
import {
	CHIEF_OF_STAFF_DEFAULT,
	DEFAULT_WORKSPACE_TRIGGERS,
	FOR_YOU_FORMAT_SKILL,
	parseSkillMd,
} from '@maskin/shared'
import { S3StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { recordEvent } from '../src/lib/events/record-event'
import { AgentStorageManager } from '../src/services/agent-storage'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FOR_YOU_HEADINGS = ['# For You list', '# For You feed']
const QUESTIONS_HEADING = '# Questions from other agents'
const BEFORE_QUESTIONS_HEADING = '# Onboarding a new workspace'
const CURATE_TRIGGER_NAME = 'For You — curate the list'
/** First sentence of the for-you-format skill before #2183 rewrote it. */
const OLD_SKILL_MARKER = "You are an agent writing one item for the human's For You queue."

export type ParsedArgs = { workspaceId: string; apply: boolean }

/** Unlike seed-default-agent, there is no default workspace: this edits live prompts, so name one. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const flag = argv.find((a) => a.startsWith('--workspace-id='))
	const raw = flag?.split('=')[1]
	if (!raw) throw new Error('--workspace-id=<uuid> is required')
	if (!UUID_RE.test(raw)) throw new Error(`Invalid workspace id: ${raw}`)
	if (argv.includes('--all')) throw new Error('--all is not supported: backfill one workspace')
	return { workspaceId: raw, apply: argv.includes('--apply') }
}

/** Splits a prompt into its `# ` sections. `chunks.join('\n')` always rebuilds the input. */
function splitSections(text: string): string[] {
	return text.split(/\n(?=# )/)
}

function headingOf(chunk: string): string {
	return chunk.split('\n', 1)[0] ?? ''
}

function findSection(chunks: string[], headings: readonly string[]): number {
	return chunks.findIndex((c) => headings.some((h) => headingOf(c).startsWith(h)))
}

function templateSection(template: string, heading: string): string {
	const chunk = splitSections(template).find((c) => headingOf(c).startsWith(heading))
	if (!chunk) throw new Error(`Template has no "${heading}" section`)
	return chunk.replace(/\s+$/, '')
}

/**
 * Brings the two sections this rollout owns up to the template, leaving every
 * other section byte-for-byte as stored. Pure, so it can be unit-tested without
 * a database.
 */
export function patchChiefOfStaffPrompt(
	current: string,
	template: string,
): { prompt: string; changed: boolean } {
	const forYou = templateSection(template, '# For You list')
	const questions = templateSection(template, QUESTIONS_HEADING)
	const chunks = splitSections(current)

	const withTrailingGap = (chunk: string, replacement: string) =>
		`${replacement}${chunk.slice(chunk.replace(/\s+$/, '').length)}`

	const forYouAt = findSection(chunks, FOR_YOU_HEADINGS)
	if (forYouAt >= 0) chunks[forYouAt] = withTrailingGap(chunks[forYouAt] as string, forYou)
	else chunks.push(forYou)

	const questionsAt = findSection(chunks, [QUESTIONS_HEADING])
	if (questionsAt >= 0) {
		chunks[questionsAt] = withTrailingGap(chunks[questionsAt] as string, questions)
	} else {
		const before = findSection(chunks, [BEFORE_QUESTIONS_HEADING])
		const gap = '\n'
		if (before >= 0) chunks.splice(before, 0, `${questions}${gap}`)
		else chunks.push(questions)
	}

	const prompt = chunks.join('\n')
	return { prompt, changed: prompt !== current }
}

export type SkillPlan = 'none' | 'update' | 'skipped-customised' | 'missing'
export type TriggerPlan = 'exists' | 'create' | 'no-chief-of-staff'
export type BackfillPlan = {
	workspaceId: string
	chiefOfStaffId: string | null
	prompt: 'none' | 'patch' | 'no-chief-of-staff'
	skill: SkillPlan
	trigger: TriggerPlan
}

export function planSkill(stored: string | null): SkillPlan {
	if (stored === null) return 'missing'
	if (stored === FOR_YOU_FORMAT_SKILL.content) return 'none'
	return stored.includes(OLD_SKILL_MARKER) ? 'update' : 'skipped-customised'
}

/**
 * Computes the plan and, when `apply` is set, performs it. The plan is returned
 * either way so a dry run and the real run report identical things.
 */
export async function backfillForYouCuration(
	db: Database,
	storage: AgentStorageManager | null,
	workspaceId: string,
	apply: boolean,
): Promise<BackfillPlan> {
	const [ws] = await db
		.select({ id: workspaces.id, createdBy: workspaces.createdBy })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!ws) throw new Error(`Workspace ${workspaceId} not found`)
	if (!ws.createdBy) throw new Error(`Workspace ${workspaceId} has no created_by actor`)
	const actingActorId = ws.createdBy

	const [chief] = await db
		.select({ id: actors.id, systemPrompt: actors.systemPrompt })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, CHIEF_OF_STAFF_DEFAULT.name),
				eq(actors.type, 'agent'),
			),
		)
		.limit(1)

	const [skill] = await db
		.select({ id: workspaceSkills.id, content: workspaceSkills.content })
		.from(workspaceSkills)
		.where(
			and(
				eq(workspaceSkills.workspaceId, workspaceId),
				eq(workspaceSkills.name, FOR_YOU_FORMAT_SKILL.name),
			),
		)
		.limit(1)

	const [existingTrigger] = await db
		.select({ id: triggers.id })
		.from(triggers)
		.where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.name, CURATE_TRIGGER_NAME)))
		.limit(1)

	const promptPatch = chief
		? patchChiefOfStaffPrompt(
				chief.systemPrompt ?? '',
				CHIEF_OF_STAFF_DEFAULT.systemPrompt.replaceAll('{{self_id}}', chief.id),
			)
		: null
	const skillPlan = planSkill(skill?.content ?? null)
	const triggerTemplate = DEFAULT_WORKSPACE_TRIGGERS.find((t) => t.name === CURATE_TRIGGER_NAME)
	if (!triggerTemplate) throw new Error(`Template has no "${CURATE_TRIGGER_NAME}" trigger`)

	const plan: BackfillPlan = {
		workspaceId,
		chiefOfStaffId: chief?.id ?? null,
		prompt: !promptPatch ? 'no-chief-of-staff' : promptPatch.changed ? 'patch' : 'none',
		skill: skillPlan,
		trigger: !chief ? 'no-chief-of-staff' : existingTrigger ? 'exists' : 'create',
	}
	if (!apply) return plan

	if (chief && promptPatch?.changed) {
		await db.transaction(async (tx) => {
			await tx
				.update(actors)
				.set({ systemPrompt: promptPatch.prompt })
				.where(eq(actors.id, chief.id))
			await recordEvent(tx, {
				workspaceId,
				actorId: actingActorId,
				action: 'updated',
				entityType: 'actor',
				entityId: chief.id,
				data: { field: 'system_prompt', source: 'backfill-for-you-curation' },
			})
		})
	}

	if (skill && skillPlan === 'update') {
		if (!storage) throw new Error('Storage is required to update the for-you-format skill')
		const content = FOR_YOU_FORMAT_SKILL.content
		const parsed = parseSkillMd(content)
		// Object store first: if it fails the row still matches what is stored.
		const { sizeBytes } = await storage.putWorkspaceSkill(workspaceId, skill.id, content)
		await db.transaction(async (tx) => {
			await tx
				.update(workspaceSkills)
				.set({ content, sizeBytes, description: parsed.description, updatedAt: new Date() })
				.where(eq(workspaceSkills.id, skill.id))
			await recordEvent(tx, {
				workspaceId,
				actorId: actingActorId,
				action: 'updated',
				entityType: 'workspace_skill',
				entityId: skill.id,
				data: { name: FOR_YOU_FORMAT_SKILL.name, source: 'backfill-for-you-curation' },
			})
		})
	}

	if (chief && !existingTrigger) {
		await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(triggers)
				.values({
					workspaceId,
					name: triggerTemplate.name,
					type: triggerTemplate.type,
					config: triggerTemplate.config as Record<string, unknown>,
					actionPrompt: triggerTemplate.actionPrompt,
					targetActorId: chief.id,
					enabled: triggerTemplate.enabled,
					createdBy: actingActorId,
				})
				.returning({ id: triggers.id })
			if (!created) throw new Error('Failed to create the curation trigger')
			await recordEvent(tx, {
				workspaceId,
				actorId: actingActorId,
				action: 'created',
				entityType: 'trigger',
				entityId: created.id,
				data: { trigger_name: triggerTemplate.name, type: triggerTemplate.type },
			})
		})
	}

	return plan
}

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}
	let args: ParsedArgs
	try {
		args = parseArgs(process.argv)
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	const db = createDb(url)
	const storage = new AgentStorageManager(
		new S3StorageProvider({
			endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
			bucket: process.env.S3_BUCKET ?? 'agent-files',
			accessKeyId: process.env.S3_ACCESS_KEY ?? 'admin',
			secretAccessKey: process.env.S3_SECRET_KEY ?? 'admin',
			region: process.env.S3_REGION ?? 'us-east-1',
		}),
		db,
	)

	const plan = await backfillForYouCuration(db, storage, args.workspaceId, args.apply)
	console.log(JSON.stringify({ mode: args.apply ? 'applied' : 'dry-run', ...plan }, null, 2))
	if (!args.apply) console.log('Nothing was written. Re-run with --apply to make these changes.')
	process.exit(0)
}

// Only run when invoked as a script, so tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
