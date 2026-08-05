import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	catalogPackageItems,
	catalogPackages,
	installedPackages,
	workspaceSkills,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager, workspaceSkillKey } from '../../services/agent-storage'
import { PackageVersionPusher } from '../../services/package-version-pusher'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedPackagesRoutes } = await import('../../routes/installed-packages')

type Env = {
	Variables: {
		db: Database
		actorId: string
		agentStorage: AgentStorageManager
	}
}

/**
 * Minimal in-memory StorageProvider so the install/uninstall/fork paths exercise
 * the real S3 read/write/delete calls without needing SeaweedFS in CI. Mirrors
 * the helper in workspace-skills.test.ts.
 */
function createMemoryStorage(): StorageProvider & { _store: Map<string, Buffer> } {
	const store = new Map<string, Buffer>()
	return {
		_store: store,
		async put(key, data) {
			if (Buffer.isBuffer(data)) {
				store.set(key, data)
			} else if (data instanceof Uint8Array) {
				store.set(key, Buffer.from(data))
			} else {
				throw new Error('Streaming put not supported in memory storage')
			}
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

function createInstalledPackagesApp(storage: StorageProvider, actorId = getTestActorId()) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})

	const agentStorage = new AgentStorageManager(storage, db)

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('agentStorage', agentStorage)
		await next()
	})

	app.route('/api/installed-packages', installedPackagesRoutes)

	return app
}

const SKILL_NAME = 'deploy-prod'
const SKILL_CONTENT = '---\nname: deploy-prod\ndescription: Ship to prod\n---\n\nRun the deploy.'

/**
 * Seed a catalog package with one actor item and one skill item. The skill's
 * `attachedActorIds` references the actor item's `source_item_id`, so the
 * two-pass provisioner has an actor→skill binding to resolve. The skill
 * snapshot deliberately carries a FOREIGN `storageKey`/`workspaceId` — an
 * untrusted publisher snapshot the installer must ignore (the cross-workspace
 * S3 leak this whole suite guards against).
 */
async function seedSkillPackage(overrides?: { content?: string; version?: string }) {
	const [pkg] = await db
		.insert(catalogPackages)
		.values({
			name: 'Deploy Kit',
			slug: `deploy-kit-${randomUUID()}`,
			description: 'Ship things to prod',
			version: overrides?.version ?? '1.0.0',
			useCase: 'development',
		})
		.returning()
	if (!pkg) throw new Error('catalog_packages insert returned no row')

	// Source ids as they existed in the publishing workspace.
	const sourceActorId = randomUUID()
	const sourceSkillId = randomUUID()
	const foreignWorkspaceId = randomUUID()

	const [actorItem] = await db
		.insert(catalogPackageItems)
		.values({
			packageId: pkg.id,
			itemType: 'actor',
			sourceItemId: sourceActorId,
			itemSnapshot: {
				type: 'agent',
				name: 'Deploy Bot',
				description: 'Ships to prod',
				systemPrompt: 'You deploy things.',
				llmProvider: 'anthropic',
				llmConfig: {},
				tools: {},
			},
		})
		.returning()
	if (!actorItem) throw new Error('actor catalog_package_items insert returned no row')

	const [skillItem] = await db
		.insert(catalogPackageItems)
		.values({
			packageId: pkg.id,
			itemType: 'skill',
			sourceItemId: sourceSkillId,
			itemSnapshot: {
				name: SKILL_NAME,
				description: 'Ship to prod',
				content: overrides?.content ?? SKILL_CONTENT,
				isValid: true,
				// Binds this skill to the actor item published in the same package.
				attachedActorIds: [sourceActorId],
				// Untrusted publisher fields the installer must NOT honor:
				storageKey: `workspaces/${foreignWorkspaceId}/skills/${sourceSkillId}/SKILL.md`,
				workspaceId: foreignWorkspaceId,
			},
		})
		.returning()
	if (!skillItem) throw new Error('skill catalog_package_items insert returned no row')

	return { pkg, actorItem, skillItem, sourceActorId, sourceSkillId, foreignWorkspaceId }
}

async function install(
	app: ReturnType<typeof createInstalledPackagesApp>,
	packageId: string,
	workspaceId: string,
) {
	const res = await app.request(
		jsonRequest('POST', '/api/installed-packages', { packageId, workspaceId }),
	)
	return res
}

describe('Installed Packages — Skills Integration', () => {
	let workspaceId: string
	let storage: ReturnType<typeof createMemoryStorage>

	beforeEach(async () => {
		// The global beforeEach clears workspace-scoped tables (installed_packages,
		// workspace_skills, agent_skills cascade off workspaces) but NOT the global
		// catalog tables — clear them here so packages don't accumulate across tests.
		await rawSql`TRUNCATE catalog_packages, catalog_package_items CASCADE`
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
		storage = createMemoryStorage()
	})

	describe('install', () => {
		it('provisions a workspace-scoped skill, uploads its content to S3, and binds it to the provisioned actor', async () => {
			const { pkg, sourceActorId, sourceSkillId, foreignWorkspaceId } = await seedSkillPackage()
			const app = createInstalledPackagesApp(storage)

			const res = await install(app, pkg.id, workspaceId)
			expect(res.status).toBe(201)
			const installed = await res.json()
			expect(installed.provisioned).toMatchObject({ actors: 1, skills: 1 })

			// The skill row landed in the INSTALLER's workspace.
			const skillRows = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.workspaceId, workspaceId))
			expect(skillRows).toHaveLength(1)
			const skill = skillRows[0]
			if (!skill) throw new Error('provisioned skill row not found')
			expect(skill.name).toBe(SKILL_NAME)

			// storageKey is scoped to the installer's own workspace + a FRESH skill id
			// — never the publisher's workspace or the snapshot's storageKey.
			expect(skill.id).not.toBe(sourceSkillId)
			expect(skill.storageKey).toBe(workspaceSkillKey(workspaceId, skill.id))
			expect(skill.storageKey).toContain(workspaceId)
			expect(skill.storageKey).not.toContain(foreignWorkspaceId)
			expect(skill.storageKey).not.toContain(sourceSkillId)

			// Content is really in storage at that key (real read), and the foreign
			// key from the snapshot was never written.
			const stored = await new AgentStorageManager(storage, db).getWorkspaceSkill(
				workspaceId,
				skill.id,
			)
			expect(stored).toBe(SKILL_CONTENT)
			expect(storage._store.get(skill.storageKey)?.toString('utf-8')).toBe(SKILL_CONTENT)
			expect(
				storage._store.has(`workspaces/${foreignWorkspaceId}/skills/${sourceSkillId}/SKILL.md`),
			).toBe(false)

			// The provisioned actor (from the companion actor item) is bound to the
			// new skill via agent_skills — proving two-pass sourceToLocal resolution.
			const [actorRow] = await db
				.select({ id: actors.id })
				.from(actors)
				.where(
					and(
						sql`${actors.metadata}->>'installed_package_id' = ${installed.id}`,
						sql`${actors.metadata}->>'source_item_id' = ${sourceActorId}`,
					),
				)
			if (!actorRow) throw new Error('provisioned actor row not found')

			const bindings = await db
				.select()
				.from(agentSkills)
				.where(eq(agentSkills.workspaceSkillId, skill.id))
			expect(bindings).toHaveLength(1)
			const [binding] = bindings
			if (!binding) throw new Error('agent_skills binding not found')
			expect(binding.actorId).toBe(actorRow.id)
		})
	})

	describe('uninstall', () => {
		it('hard-deletes the skill row, its S3 object, and the agent_skills binding', async () => {
			const { pkg } = await seedSkillPackage()
			const app = createInstalledPackagesApp(storage)

			const installRes = await install(app, pkg.id, workspaceId)
			expect(installRes.status).toBe(201)
			const installed = await installRes.json()

			const [skill] = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.workspaceId, workspaceId))
			if (!skill) throw new Error('provisioned skill row not found')
			expect(storage._store.has(skill.storageKey)).toBe(true)

			const res = await app.request(
				jsonRequest('DELETE', `/api/installed-packages/${installed.id}`, {
					keepProvisionedItems: false,
				}),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
			expect(body.removedElements).toMatchObject({ skills: 1 })

			// DB row gone.
			const remaining = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.id, skill.id))
			expect(remaining).toHaveLength(0)

			// S3 object really deleted (not just the DB row).
			expect(storage._store.has(skill.storageKey)).toBe(false)

			// No orphaned join row survives.
			const bindings = await db
				.select()
				.from(agentSkills)
				.where(eq(agentSkills.workspaceSkillId, skill.id))
			expect(bindings).toHaveLength(0)
		})
	})

	describe('fork', () => {
		it('detaches the skill to workspace ownership while keeping its own S3 object', async () => {
			const { pkg } = await seedSkillPackage()
			const app = createInstalledPackagesApp(storage)

			const installRes = await install(app, pkg.id, workspaceId)
			const installed = await installRes.json()

			const [before] = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.workspaceId, workspaceId))
			if (!before) throw new Error('provisioned skill row not found')

			const res = await app.request(
				jsonRequest('POST', `/api/installed-packages/${installed.id}/fork`),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.isLocked).toBe(false)
			expect(body.detached).toMatchObject({ actors: 1, skills: 1 })

			// The skill survives the fork with the SAME workspace-scoped storageKey
			// and S3 object — fork detaches ownership, it does not re-key or orphan.
			const [after] = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.id, before.id))
			if (!after) throw new Error('forked skill row not found')
			expect(after.storageKey).toBe(before.storageKey)
			expect(storage._store.get(after.storageKey)?.toString('utf-8')).toBe(SKILL_CONTENT)

			// Metadata flipped from managed to forked-owned.
			const meta = after.metadata as Record<string, unknown>
			expect(meta.installed_package_id).toBeUndefined()
			expect(meta.forked_from_installed_package_id).toBe(installed.id)

			// The agent_skills binding is untouched by the fork.
			const bindings = await db
				.select()
				.from(agentSkills)
				.where(eq(agentSkills.workspaceSkillId, before.id))
			expect(bindings).toHaveLength(1)
		})

		it('uninstalling a forked install still removes the forked skill and its S3 object', async () => {
			const { pkg } = await seedSkillPackage()
			const app = createInstalledPackagesApp(storage)

			const installRes = await install(app, pkg.id, workspaceId)
			const installed = await installRes.json()

			const [skill] = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.workspaceId, workspaceId))
			if (!skill) throw new Error('provisioned skill row not found')

			// Fork, then hard-uninstall the forked install.
			const forkRes = await app.request(
				jsonRequest('POST', `/api/installed-packages/${installed.id}/fork`),
			)
			expect(forkRes.status).toBe(200)

			const res = await app.request(
				jsonRequest('DELETE', `/api/installed-packages/${installed.id}`, {
					keepProvisionedItems: false,
				}),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			// The uninstall WHERE clause must match `forked_from_installed_package_id`,
			// not just `installed_package_id`, or the forked skill leaks.
			expect(body.removedElements).toMatchObject({ skills: 1 })

			const remaining = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.id, skill.id))
			expect(remaining).toHaveLength(0)
			expect(storage._store.has(skill.storageKey)).toBe(false)
		})
	})

	describe('version re-push (cron)', () => {
		it('updates the installed skill content in place and keeps the same storageKey', async () => {
			const { pkg, skillItem } = await seedSkillPackage()
			const app = createInstalledPackagesApp(storage)

			const installRes = await install(app, pkg.id, workspaceId)
			expect(installRes.status).toBe(201)
			const installed = await installRes.json()

			const [before] = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.workspaceId, workspaceId))
			if (!before) throw new Error('provisioned skill row not found')
			const originalStorageKey = before.storageKey

			// Publisher ships a new version with updated skill content.
			const NEW_CONTENT =
				'---\nname: deploy-prod\ndescription: Ship to prod v2\n---\n\nDeploy carefully.'
			await db
				.update(catalogPackageItems)
				.set({
					itemSnapshot: {
						...(skillItem.itemSnapshot as Record<string, unknown>),
						content: NEW_CONTENT,
						description: 'Ship to prod v2',
					},
				})
				.where(eq(catalogPackageItems.id, skillItem.id))
			await db
				.update(catalogPackages)
				.set({ version: '1.1.0' })
				.where(eq(catalogPackages.id, pkg.id))

			// The cron re-syncs the locked install.
			const pusher = new PackageVersionPusher(db, new AgentStorageManager(storage, db))
			await pusher.tick()

			const [after] = await db
				.select()
				.from(workspaceSkills)
				.where(eq(workspaceSkills.id, before.id))
			if (!after) throw new Error('updated skill row not found')
			expect(after.content).toBe(NEW_CONTENT)
			expect(after.description).toBe('Ship to prod v2')
			expect(after.sizeBytes).toBe(Buffer.byteLength(NEW_CONTENT, 'utf-8'))
			// storageKey is stable — content is refreshed at the same S3 key.
			expect(after.storageKey).toBe(originalStorageKey)
			expect(storage._store.get(originalStorageKey)?.toString('utf-8')).toBe(NEW_CONTENT)

			// Install version bumped so the cron is idempotent on the next tick.
			const [inst] = await db
				.select()
				.from(installedPackages)
				.where(eq(installedPackages.id, installed.id))
			if (!inst) throw new Error('installed_packages row not found')
			expect(inst.installedVersion).toBe('1.1.0')
		})
	})
})
