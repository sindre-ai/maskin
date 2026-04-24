import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Database } from '@maskin/db'
import { agentFiles, agentSkills, workspaceSkills } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { appendToLedger } from './workspace-briefing'

export const AGENT_STORAGE_PREFIX = 'agents'
export const WORKSPACE_SKILLS_PREFIX = 'workspaces'

// Keyed on the skill's UUID so concurrent writers with the same `name` can
// never collide on the same S3 object — a stale rollback from a losing writer
// cannot then delete the winner's object.
export function workspaceSkillKey(workspaceId: string, skillId: string): string {
	return `${WORKSPACE_SKILLS_PREFIX}/${workspaceId}/skills/${skillId}/SKILL.md`
}

export type PullWorkspaceSkillsResult = {
	pulled: number
	skipped: number
	failures: { name: string; storageKey: string; error: string }[]
}

export class AgentStorageManager {
	constructor(
		private storage: StorageProvider,
		private db: Database,
	) {}

	/**
	 * Pull all agent files from S3 into a local directory.
	 * Creates the directory structure: /agent/{skills,learnings,memory}
	 */
	async pullAgentFiles(actorId: string, workspaceId: string, localDir: string): Promise<void> {
		const prefix = `agents/${workspaceId}/${actorId}/`
		const keys = await this.storage.list(prefix)

		// Per-key try/catch so one bad object doesn't abort the whole pull with an
		// opaque first-error message. We collect every failure and throw an
		// aggregate at the end so the caller (session-manager.start) sees every
		// missing/unreadable file instead of just the first.
		const failures: { key: string; error: string }[] = []
		for (const key of keys) {
			const relativePath = key.slice(prefix.length)
			const localPath = join(localDir, relativePath)
			try {
				const parentDir = join(localPath, '..')
				await mkdir(parentDir, { recursive: true })
				const data = await this.storage.get(key)
				await writeFile(localPath, data)
			} catch (err) {
				logger.error('Failed to pull agent file', {
					actorId,
					workspaceId,
					key,
					error: String(err),
				})
				failures.push({ key, error: String(err) })
			}
		}

		// Ensure directory structure exists even if empty
		await mkdir(join(localDir, 'skills'), { recursive: true })
		await mkdir(join(localDir, 'learnings'), { recursive: true })
		await mkdir(join(localDir, 'memory'), { recursive: true })
		await mkdir(join(localDir, 'workspace'), { recursive: true })

		logger.info(`Pulled ${keys.length - failures.length}/${keys.length} agent files`, {
			actorId,
			workspaceId,
			failed: failures.length,
		})

		if (failures.length > 0) {
			const summary = failures.map((f) => `${f.key}: ${f.error}`).join('; ')
			throw new Error(
				`Failed to pull ${failures.length}/${keys.length} agent files for ${actorId}: ${summary}`,
			)
		}
	}

	/**
	 * Push new/changed files back to S3 after a session completes.
	 * Pushes the per-session learning file, any memory updates, and appends a
	 * one-line entry to the workspace-scoped learnings ledger so future sessions
	 * in this workspace can see what was tried.
	 */
	async pushAgentFiles(
		actorId: string,
		workspaceId: string,
		sessionId: string,
		localDir: string,
		opts?: { actionPrompt?: string },
	): Promise<void> {
		let pushed = 0

		// Push per-session learning file if it exists
		const learningsDir = join(localDir, 'learnings')
		const learningFile = `session-${sessionId}.md`
		const learningPath = join(learningsDir, learningFile)

		try {
			const data = await readFile(learningPath)
			const relativePath = `learnings/${learningFile}`
			const key = `agents/${workspaceId}/${actorId}/${relativePath}`
			await this.storage.put(key, data)
			await this.upsertFileRecord(
				actorId,
				workspaceId,
				'learning',
				relativePath,
				key,
				data.length,
				sessionId,
			)
			pushed++
		} catch (err) {
			// ENOENT just means the session didn't produce a learning file — fine.
			// Anything else (S3 5xx, auth expiry, DB failure in upsertFileRecord)
			// is a real error we must not swallow silently.
			if (!isFileNotFound(err)) {
				logger.error('Failed to push session learning file', {
					actorId,
					workspaceId,
					sessionId,
					error: String(err),
				})
			}
		}

		// Push memory files (CLAUDE.md, consolidated-learnings.md, etc.).
		// Missing directory is fine (agent may never have written memory); a
		// mid-loop upload failure for any specific file is a real error and is
		// logged per-file so partial uploads don't silently desync.
		const memoryDir = join(localDir, 'memory')
		let memoryFiles: string[] = []
		try {
			memoryFiles = await readdir(memoryDir)
		} catch (err) {
			if (!isFileNotFound(err)) {
				logger.error('Failed to read memory directory', {
					actorId,
					workspaceId,
					sessionId,
					error: String(err),
				})
			}
		}

		for (const file of memoryFiles) {
			const filePath = join(memoryDir, file)
			try {
				const data = await readFile(filePath)
				const relativePath = `memory/${file}`
				const key = `agents/${workspaceId}/${actorId}/${relativePath}`
				await this.storage.put(key, data)
				await this.upsertFileRecord(
					actorId,
					workspaceId,
					'memory',
					relativePath,
					key,
					data.length,
					sessionId,
				)
				pushed++
			} catch (err) {
				logger.error('Failed to push memory file', {
					actorId,
					workspaceId,
					sessionId,
					file,
					error: String(err),
				})
			}
		}

		await this.appendWorkspaceLedger(workspaceId, sessionId, localDir, opts?.actionPrompt)

		logger.info(`Pushed ${pushed} files to storage`, { actorId, workspaceId, sessionId })
	}

	/**
	 * Append a one-line summary of this session to the workspace ledger so every
	 * future session's briefing can surface what was tried across the whole
	 * workspace. Prefers SESSION_LEARNING.md first line, falls back to the
	 * action prompt. Silent on failure — ledger is best-effort.
	 */
	private async appendWorkspaceLedger(
		workspaceId: string,
		sessionId: string,
		localDir: string,
		actionPromptFallback?: string,
	): Promise<void> {
		let summary = ''
		try {
			const buf = await readFile(join(localDir, 'workspace', 'SESSION_LEARNING.md'))
			const firstLine = buf
				.toString('utf-8')
				.split('\n')
				.find((l) => l.trim().length > 0)
			if (firstLine) summary = firstLine.trim()
		} catch (err) {
			if (!isFileNotFound(err)) {
				logger.warn('Failed to read SESSION_LEARNING.md for ledger', {
					workspaceId,
					sessionId,
					error: String(err),
				})
			}
		}

		if (!summary && actionPromptFallback) {
			summary = actionPromptFallback.trim().split('\n')[0] ?? ''
		}
		if (!summary) summary = '(no learning recorded)'

		const maxSummary = 200
		if (summary.length > maxSummary) summary = `${summary.slice(0, maxSummary - 1)}…`

		const timestamp = new Date().toISOString()
		const line = `${timestamp} · session ${sessionId.slice(0, 8)} · ${summary}`
		try {
			await appendToLedger(this.storage, workspaceId, line)
		} catch (err) {
			logger.warn('Failed to append to workspace ledger', {
				workspaceId,
				sessionId,
				error: String(err),
			})
		}
	}

	/**
	 * Get a single file's content from S3.
	 */
	async getFile(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
	): Promise<Buffer> {
		const relativePath = `${fileType}/${path}`
		const key = `agents/${workspaceId}/${actorId}/${relativePath}`
		return this.storage.get(key)
	}

	/**
	 * List file records from DB (metadata: id, path, sizeBytes, updatedAt).
	 */
	async listFileRecords(actorId: string, workspaceId: string, fileType?: string) {
		const conditions = [eq(agentFiles.actorId, actorId), eq(agentFiles.workspaceId, workspaceId)]
		if (fileType) conditions.push(eq(agentFiles.fileType, fileType))
		return this.db
			.select()
			.from(agentFiles)
			.where(and(...conditions))
	}

	/**
	 * Upload a single file (skill, config, etc.) to agent storage.
	 */
	async uploadFile(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
		content: Buffer,
	): Promise<string> {
		const relativePath = `${fileType}/${path}`
		const key = `agents/${workspaceId}/${actorId}/${relativePath}`
		await this.storage.put(key, content)
		await this.upsertFileRecord(actorId, workspaceId, fileType, relativePath, key, content.length)
		return key
	}

	/**
	 * List files for an agent, optionally filtered by type.
	 */
	async listFiles(actorId: string, workspaceId: string, fileType?: string): Promise<string[]> {
		const prefix = fileType
			? `agents/${workspaceId}/${actorId}/${fileType}/`
			: `agents/${workspaceId}/${actorId}/`
		return this.storage.list(prefix)
	}

	/**
	 * Delete a file from agent storage.
	 */
	async deleteFile(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
	): Promise<void> {
		const relativePath = `${fileType}/${path}`
		const key = `agents/${workspaceId}/${actorId}/${relativePath}`
		await this.storage.delete(key)

		await this.db
			.delete(agentFiles)
			.where(
				and(
					eq(agentFiles.actorId, actorId),
					eq(agentFiles.workspaceId, workspaceId),
					eq(agentFiles.path, relativePath),
				),
			)
	}

	async putWorkspaceSkill(
		workspaceId: string,
		skillId: string,
		content: string,
	): Promise<{ storageKey: string; sizeBytes: number }> {
		const storageKey = workspaceSkillKey(workspaceId, skillId)
		const buffer = Buffer.from(content, 'utf-8')
		await this.storage.put(storageKey, buffer)
		return { storageKey, sizeBytes: buffer.length }
	}

	async getWorkspaceSkill(workspaceId: string, skillId: string): Promise<string> {
		const storageKey = workspaceSkillKey(workspaceId, skillId)
		const buffer = await this.storage.get(storageKey)
		return buffer.toString('utf-8')
	}

	async deleteWorkspaceSkill(workspaceId: string, skillId: string): Promise<void> {
		const storageKey = workspaceSkillKey(workspaceId, skillId)
		await this.storage.delete(storageKey)
	}

	/**
	 * Collision rule — agent-local wins unless `overwrite: true`. If a
	 * `skills/<name>/` folder already exists on disk, the workspace skill for
	 * that name is skipped so per-agent tweaks survive. On resume we pass
	 * `overwrite: true` so updated workspace-skill content is re-pulled over
	 * stale snapshot contents.
	 */
	async pullWorkspaceSkillsForAgent(
		actorId: string,
		workspaceId: string,
		localDir: string,
		options: { overwrite?: boolean } = {},
	): Promise<PullWorkspaceSkillsResult> {
		const rows = await this.db
			.select({
				name: workspaceSkills.name,
				storageKey: workspaceSkills.storageKey,
			})
			.from(agentSkills)
			.innerJoin(workspaceSkills, eq(workspaceSkills.id, agentSkills.workspaceSkillId))
			.where(
				and(
					eq(agentSkills.actorId, actorId),
					eq(workspaceSkills.workspaceId, workspaceId),
					eq(workspaceSkills.isValid, true),
				),
			)

		if (rows.length === 0) {
			logger.info('No workspace skills attached to agent', { actorId, workspaceId })
			return { pulled: 0, skipped: 0, failures: [] }
		}

		const skillsDir = join(localDir, 'skills')
		await mkdir(skillsDir, { recursive: true })

		let pulled = 0
		let skipped = 0
		const failures: { name: string; storageKey: string; error: string }[] = []

		for (const { name, storageKey } of rows) {
			const skillFolder = join(skillsDir, name)
			if (!options.overwrite && (await folderExists(skillFolder))) {
				skipped++
				logger.info('Skipping workspace skill — agent-local folder already exists', {
					actorId,
					workspaceId,
					name,
				})
				continue
			}

			try {
				const data = await this.storage.get(storageKey)
				if (options.overwrite) {
					await rm(skillFolder, { recursive: true, force: true })
				}
				await mkdir(skillFolder, { recursive: true })
				await writeFile(join(skillFolder, 'SKILL.md'), data)
				pulled++
			} catch (err) {
				logger.error('Failed to pull workspace skill', {
					actorId,
					workspaceId,
					name,
					storageKey,
					error: String(err),
				})
				failures.push({ name, storageKey, error: String(err) })
			}
		}

		logger.info('Pulled workspace skills for agent', {
			actorId,
			workspaceId,
			pulled,
			skipped,
			failed: failures.length,
		})

		return { pulled, skipped, failures }
	}

	private async upsertFileRecord(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
		storageKey: string,
		sizeBytes: number,
		sessionId?: string,
	): Promise<void> {
		// Try update first, insert if not exists
		const updated = await this.db
			.update(agentFiles)
			.set({ storageKey, sizeBytes, sessionId, updatedAt: new Date() })
			.where(
				and(
					eq(agentFiles.actorId, actorId),
					eq(agentFiles.workspaceId, workspaceId),
					eq(agentFiles.path, path),
				),
			)
			.returning()

		if (updated.length === 0) {
			await this.db.insert(agentFiles).values({
				actorId,
				workspaceId,
				fileType,
				path,
				storageKey,
				sizeBytes,
				sessionId,
			})
		}
	}
}

async function folderExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path)
		return s.isDirectory()
	} catch {
		return false
	}
}

function isFileNotFound(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code?: string }).code === 'ENOENT'
	)
}
