import { randomUUID } from 'node:crypto'
import type { Database, Transaction } from '@maskin/db'
import { files, objects } from '@maskin/db/schema'
import { MAX_LOOP_VIEW_NAME_LENGTH, applyLoopView, readLoopViews } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { sha256Hex } from '../lib/file-save'
import { fileStorageKey } from '../lib/file-urls'
import { logger } from '../lib/logger'
import { LOOP_ID_TOKEN } from '../lib/marketplace-loops/view-snapshot'

/**
 * Custom views (the extra tabs on a loop page) for marketplace loops. Both the
 * install endpoint and the version-push cron call `syncLoopViews`, so a fresh
 * install and a pushed update end up with the same files and tabs.
 *
 * A published view is a `marketplace_loop_items` row with item_type 'view'
 * whose snapshot holds the tab name, its place in the tab order and the page
 * HTML. Install copies each one into the installer's workspace as a new HTML
 * file (never a link to the publisher's file) and pins it on the loop object
 * with the same `metadata.views` a person's own tabs use.
 *
 * Which files an install created is kept on the loop object as
 * `metadata.installed_views`, so a push and an uninstall touch only those
 * files and never a tab a person added.
 */

type DbHandle = Database | Transaction

const INSTALLED_VIEWS_KEY = 'installed_views'

export interface ViewItem {
	sourceItemId: string
	name: string
	position: number
	html: string
}

/** One file an install created from a published view. */
export interface InstalledViewRef {
	source_item_id: string
	file_id: string
	/** sha256 of the published page, to tell whether a push brings a new one. */
	source_hash: string
	/** Content hash of the file as the install last wrote it, to tell whether a person has edited it since. */
	file_hash: string
}

export interface ViewSyncCounts {
	adds: number
	updates: number
	removes: number
	/** Pages a push left alone because the workspace has edited them. */
	kept: number
	/** Files whose rows were deleted. Their bytes go with \`deleteViewFileBytes\` once the transaction commits. */
	removedFileIds: string[]
}

/** The view items among a loop's marketplace items, in tab order. Rows with no usable name or page are dropped. */
export function toViewItems(
	rows: Array<{ itemType: string; sourceItemId: string; itemSnapshot: unknown }>,
): ViewItem[] {
	const items: ViewItem[] = []
	for (const row of rows) {
		if (row.itemType !== 'view') continue
		const snapshot = (row.itemSnapshot as Record<string, unknown> | null) ?? {}
		const name = typeof snapshot.name === 'string' ? snapshot.name.trim() : ''
		if (name.length === 0 || name.length > MAX_LOOP_VIEW_NAME_LENGTH) continue
		if (typeof snapshot.html !== 'string') continue
		items.push({
			sourceItemId: row.sourceItemId,
			name,
			position: typeof snapshot.position === 'number' ? snapshot.position : 0,
			html: snapshot.html,
		})
	}
	return items.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
}

/** The page as written into the installer's workspace: the loop id token becomes the real loop object id. */
export function renderViewHtml(html: string, loopObjectId: string): string {
	return html.split(LOOP_ID_TOKEN).join(loopObjectId)
}

export function readInstalledViews(metadata: unknown): InstalledViewRef[] {
	const raw = (metadata as Record<string, unknown> | null | undefined)?.[INSTALLED_VIEWS_KEY]
	if (!Array.isArray(raw)) return []
	return raw.filter(
		(r): r is InstalledViewRef =>
			!!r &&
			typeof r === 'object' &&
			typeof (r as InstalledViewRef).source_item_id === 'string' &&
			typeof (r as InstalledViewRef).file_id === 'string',
	)
}

function sourceHash(html: string): string {
	return sha256Hex(Buffer.from(html, 'utf8'))
}

async function createViewFile(
	db: DbHandle,
	storage: StorageProvider,
	params: { workspaceId: string; actorId: string; name: string; html: string },
): Promise<{ id: string; hash: string }> {
	const id = randomUUID()
	const storageKey = fileStorageKey(params.workspaceId, id)
	const bytes = Buffer.from(params.html, 'utf8')
	const hash = sha256Hex(bytes)
	await db.insert(files).values({
		id,
		workspaceId: params.workspaceId,
		name: `${params.name}.html`,
		description: `Tab "${params.name}" on a marketplace loop`,
		mimeType: 'text/html',
		sizeBytes: bytes.byteLength,
		storageKey,
		contentHash: hash,
		createdBy: params.actorId,
	})
	await storage.put(storageKey, bytes)
	return { id, hash }
}

/**
 * Brings the loop object's tabs in line with the loop's published views:
 * creates a file and a tab for a view the install does not have yet, rewrites
 * the page when the published one changed (unless the workspace has edited it),
 * and removes the file and tab of a view the loop no longer publishes.
 *
 * Runs inside the caller's transaction. File bytes are written as the rows are,
 * so a rolled-back transaction can leave an unreferenced object in storage; its
 * key holds a fresh id, so nothing ever reads it. Bytes of removed files are
 * not touched here: the caller deletes them after the commit.
 */
export async function syncLoopViews(params: {
	db: DbHandle
	storage: StorageProvider
	workspaceId: string
	loopObjectId: string
	actorId: string
	items: ViewItem[]
}): Promise<ViewSyncCounts> {
	const { db, storage, workspaceId, loopObjectId, actorId, items } = params
	const counts: ViewSyncCounts = { adds: 0, updates: 0, removes: 0, kept: 0, removedFileIds: [] }

	const [loopObject] = await db
		.select({ metadata: objects.metadata })
		.from(objects)
		.where(eq(objects.id, loopObjectId))
		.for('update')
	if (!loopObject) return counts

	const metadata = (loopObject.metadata as Record<string, unknown> | null) ?? {}
	let views = readLoopViews(metadata)
	const refs = readInstalledViews(metadata)
	const refBySource = new Map(refs.map((r) => [r.source_item_id, r]))
	const nextRefs: InstalledViewRef[] = []

	const existingFiles = new Map<string, { contentHash: string | null; storageKey: string }>()
	if (refs.length > 0) {
		const rows = await db
			.select({ id: files.id, contentHash: files.contentHash, storageKey: files.storageKey })
			.from(files)
			.where(
				and(
					eq(files.workspaceId, workspaceId),
					inArray(
						files.id,
						refs.map((r) => r.file_id),
					),
				),
			)
		for (const r of rows) existingFiles.set(r.id, r)
	}

	for (const item of items) {
		const html = renderViewHtml(item.html, loopObjectId)
		const srcHash = sourceHash(item.html)
		const ref = refBySource.get(item.sourceItemId)
		const file = ref ? existingFiles.get(ref.file_id) : undefined

		if (ref && file) {
			if (ref.source_hash === srcHash) {
				nextRefs.push(ref)
				continue
			}
			// The published page changed. A page the workspace has edited since the
			// install wrote it is theirs now (the loop's agents fill the starter
			// pages in), so it is left as it is and only the record moves on.
			if (file.contentHash !== ref.file_hash) {
				counts.kept++
				nextRefs.push({ ...ref, source_hash: srcHash })
				continue
			}
			const bytes = Buffer.from(html, 'utf8')
			const hash = sha256Hex(bytes)
			await db
				.update(files)
				.set({ sizeBytes: bytes.byteLength, contentHash: hash, updatedAt: new Date() })
				.where(eq(files.id, ref.file_id))
			await storage.put(file.storageKey, bytes)
			// A renamed tab keeps its place; the tab is found by its file.
			views = views.map((v) => (v.fileId === ref.file_id ? { ...v, name: item.name } : v))
			nextRefs.push({ ...ref, source_hash: srcHash, file_hash: hash })
			counts.updates++
			continue
		}

		// New to this install, or its file was deleted by hand: write a fresh copy.
		const taken = views.some(
			(v) => v.name.toLowerCase() === item.name.toLowerCase() && v.fileId !== ref?.file_id,
		)
		if (taken) {
			logger.warn('Skipped marketplace loop view: a tab with that name already exists', {
				workspaceId,
				loopObjectId,
				name: item.name,
			})
			continue
		}
		const created = await createViewFile(db, storage, {
			workspaceId,
			actorId,
			name: item.name,
			html,
		})
		views = ref
			? views.map((v) => (v.fileId === ref.file_id ? { ...v, fileId: created.id } : v))
			: applyLoopView(views, item.name, created.id)
		nextRefs.push({
			source_item_id: item.sourceItemId,
			file_id: created.id,
			source_hash: srcHash,
			file_hash: created.hash,
		})
		if (!ref) counts.adds++
		else counts.updates++
	}

	// Views the loop no longer publishes: drop the install's tab and file.
	const keptSources = new Set(items.map((i) => i.sourceItemId))
	const removedFileIds = counts.removedFileIds
	for (const ref of refs) {
		if (keptSources.has(ref.source_item_id)) continue
		removedFileIds.push(ref.file_id)
		views = views.filter((v) => v.fileId !== ref.file_id)
		counts.removes++
	}
	if (removedFileIds.length > 0) {
		await db
			.delete(files)
			.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, removedFileIds)))
	}

	const viewsChanged = JSON.stringify(readLoopViews(metadata)) !== JSON.stringify(views)
	const refsChanged = JSON.stringify(refs) !== JSON.stringify(nextRefs)
	if (viewsChanged || refsChanged) {
		await db
			.update(objects)
			.set({
				metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify({
					views: views.map((v) => ({ name: v.name, file_id: v.fileId })),
					view_file_id: null,
					[INSTALLED_VIEWS_KEY]: nextRefs,
				})}::jsonb`,
				updatedAt: new Date(),
			})
			.where(eq(objects.id, loopObjectId))
	}

	return counts
}

/**
 * Deletes the rows of the files an install created from published views and
 * returns their ids. Used by uninstall, before the loop object is deleted (the
 * tabs go with the object). `metadata` is the loop object's metadata. The
 * caller deletes the bytes with `deleteViewFileBytes` once the transaction
 * commits.
 */
export async function removeInstalledViewFiles(params: {
	db: DbHandle
	workspaceId: string
	metadata: unknown
}): Promise<string[]> {
	const { db, workspaceId, metadata } = params
	const fileIds = readInstalledViews(metadata).map((r) => r.file_id)
	if (fileIds.length === 0) return []
	await db.delete(files).where(and(eq(files.workspaceId, workspaceId), inArray(files.id, fileIds)))
	return fileIds
}

/** Deletes the stored bytes of removed view files. A failure is logged: the object is inert once its row is gone. */
export async function deleteViewFileBytes(
	storage: StorageProvider,
	workspaceId: string,
	fileIds: string[],
): Promise<void> {
	for (const fileId of fileIds) {
		try {
			await storage.delete(fileStorageKey(workspaceId, fileId))
		} catch (err) {
			logger.error('Failed to delete loop view file from storage (orphan object left)', {
				workspaceId,
				fileId,
				error: String(err),
			})
		}
	}
}
