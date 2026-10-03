import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, desc, eq, ilike } from 'drizzle-orm'
import { type RobinsonList, normalizeDanishNumber } from './dnc-gate'

/**
 * The quarterly Robinson CSV, uploaded as a workspace file. The newest file
 * whose name contains "robinson" is the list. Each CSV cell is read either as a
 * phone number (normalised to +45XXXXXXXX) or as the sha256 hex digest of one,
 * so the list may be shipped hashed. No file, or one that cannot be read, makes
 * the lookup throw, which the gate treats as "unavailable" and fails closed.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/i
const RECHECK_MS = 60_000

export function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

export function parseRobinsonCsv(text: string): Set<string> {
	const entries = new Set<string>()
	for (const line of text.split(/\r?\n/)) {
		for (const cell of line.split(/[,;\t]/)) {
			const value = cell.trim().replace(/^"|"$/g, '')
			if (!value) continue
			if (SHA256_HEX.test(value)) {
				entries.add(value.toLowerCase())
				continue
			}
			const number = normalizeDanishNumber(value)
			if (number) entries.add(number)
		}
	}
	return entries
}

export function robinsonListFromSet(entries: ReadonlySet<string>): RobinsonList {
	return { has: (number) => entries.has(number) || entries.has(sha256Hex(number)) }
}

interface Loaded {
	fileId: string
	updatedAt: number
	checkedAt: number
	list: RobinsonList
}

/** Loads and caches the workspace's Robinson list. The files row is rechecked at most once a minute. */
export class WorkspaceRobinsonLists {
	private cache = new Map<string, Loaded>()

	constructor(
		private db: Database,
		private storage: Pick<StorageProvider, 'get'>,
		private clock: () => number = Date.now,
	) {}

	forWorkspace(workspaceId: string): RobinsonList {
		return { has: async (number) => (await this.load(workspaceId)).has(number) }
	}

	private async load(workspaceId: string): Promise<RobinsonList> {
		const now = this.clock()
		const cached = this.cache.get(workspaceId)
		if (cached && now - cached.checkedAt < RECHECK_MS) return cached.list

		const [row] = await this.db
			.select({ id: files.id, storageKey: files.storageKey, updatedAt: files.updatedAt })
			.from(files)
			.where(and(eq(files.workspaceId, workspaceId), ilike(files.name, '%robinson%')))
			.orderBy(desc(files.createdAt))
			.limit(1)
		if (!row) throw new Error('no Robinson list file in the workspace')

		const updatedAt = row.updatedAt.getTime()
		if (cached && cached.fileId === row.id && cached.updatedAt === updatedAt) {
			cached.checkedAt = now
			return cached.list
		}
		const text = (await this.storage.get(row.storageKey)).toString('utf8')
		const entries = parseRobinsonCsv(text)
		if (entries.size === 0) throw new Error('Robinson list file has no readable entries')
		const list = robinsonListFromSet(entries)
		this.cache.set(workspaceId, { fileId: row.id, updatedAt, checkedAt: now, list })
		return list
	}
}
