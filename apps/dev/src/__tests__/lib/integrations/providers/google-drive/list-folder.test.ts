import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replayCassette } from './cassette'
import treeCassette from './cassettes/list-folder-tree.json'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getToken = vi.fn()
vi.mock('../../../../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getToken(...args),
}))

const capture = vi.fn()
vi.mock('../../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capture(...args),
}))

import type { DriveClient } from '../../../../../lib/integrations/providers/google-drive/client'
import {
	RECURSIVE_MAX_DEPTH,
	RECURSIVE_MAX_FILES,
	listFolder,
} from '../../../../../lib/integrations/providers/google-drive/tools/list-folder'

const ctx = { db: {} as never, workspaceId: 'ws-1', actorId: 'actor-1' }

beforeEach(() => {
	getToken.mockReset().mockResolvedValue({ accessToken: 'tok', integrationId: 'int-1' })
	capture.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('listFolder non-recursive (cassette)', () => {
	it('returns one page, tags shortcuts with shortcutTargetId, never descends', async () => {
		const fetchSpy = replayCassette(treeCassette)

		const out = await listFolder(ctx, { folderId: 'root' })

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(out.truncated).toBeUndefined()
		expect(out.nextPageToken).toBeUndefined()
		expect(out.files.map((f) => f.id)).toEqual(['doc1', 'sub1', 'sc1', 'sc2'])
		expect(out.files.find((f) => f.id === 'sc1')?.shortcutTargetId).toBe('sub1')
		expect(out.files.find((f) => f.id === 'sc2')?.shortcutTargetId).toBe('pdf9')
		expect(out.files.find((f) => f.id === 'doc1')?.shortcutTargetId).toBeUndefined()
	})

	it('hands back nextPageToken and accepts it as pageToken', async () => {
		replayCassette(treeCassette)
		const first = await listFolder(ctx, { folderId: 'sub1' })
		expect(first.nextPageToken).toBe('sub1-p2')
		const second = await listFolder(ctx, { folderId: 'sub1', pageToken: 'sub1-p2' })
		expect(second.files.map((f) => f.id)).toEqual(['sub2'])
		expect(second.nextPageToken).toBeUndefined()
	})

	it('escapes quotes and backslashes in the folder id so it cannot inject query terms', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(JSON.stringify({ files: [] }), { status: 200 }))
		await listFolder(ctx, { folderId: "x' in parents or 'a\\b" })
		const q = new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('q')
		expect(q).toBe("'x\\' in parents or \\'a\\\\b' in parents and trashed = false")
	})

	it('defaults pageSize to 100 and caps it at 1000', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(JSON.stringify({ files: [] }), { status: 200 }))
		await listFolder(ctx, { folderId: 'f' })
		await listFolder(ctx, { folderId: 'f', pageSize: 99999 })
		const size = (i: number) =>
			new URL(String(fetchSpy.mock.calls[i]?.[0])).searchParams.get('pageSize')
		expect(size(0)).toBe('100')
		expect(size(1)).toBe('1000')
	})

	it('emits drive_folder_walked with counts and flags, never ids or names', async () => {
		replayCassette(treeCassette)
		await listFolder(ctx, { folderId: 'root' })
		const [event, distinctId, props] = capture.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
		]
		expect(event).toBe('drive_folder_walked')
		expect(distinctId).toBe('actor-1')
		expect(props).toEqual({
			provider: 'google-drive',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			recursive: false,
			file_count: 4,
			truncated: false,
			has_more: false,
		})
	})
})

describe('listFolder recursive (cassette)', () => {
	it('walks breadth-first through pages and subfolders, entering a shortcut-target folder once', async () => {
		const fetchSpy = replayCassette(treeCassette)

		const out = await listFolder(ctx, { folderId: 'root', recursive: true })

		expect(out.truncated).toBeUndefined()
		expect(out.files.map((f) => f.id)).toEqual([
			// level 1: root
			'doc1',
			'sub1',
			'sc1',
			'sc2',
			// level 2: sub1 (two pages)
			'sheet1',
			'sub2',
			// level 3: sub2
			'deep1',
		])
		// sc1 points at sub1, which was already entered: sub1 is listed once, not twice.
		const subOneCalls = fetchSpy.mock.calls.filter((c) =>
			new URL(String(c[0])).searchParams.get('q')?.startsWith("'sub1'"),
		)
		expect(subOneCalls).toHaveLength(2) // page 1 + page 2, nothing more
	})

	it('truncates at 5000 files with truncated true and the last page token seen', async () => {
		const page = (n: number, prefix: string) =>
			Array.from({ length: n }, (_, i) => ({
				id: `${prefix}${i}`,
				name: `f${i}`,
				mimeType: 'text/plain',
			}))
		const client: DriveClient = {
			listFiles: vi
				.fn()
				.mockResolvedValueOnce({ files: page(3000, 'a'), nextPageToken: 'tok-2' })
				.mockResolvedValueOnce({ files: page(3000, 'b'), nextPageToken: 'tok-3' }),
		}
		const out = await listFolder({ ...ctx, client }, { folderId: 'big', recursive: true })

		expect(out.files).toHaveLength(RECURSIVE_MAX_FILES)
		expect(out.truncated).toBe(true)
		expect(out.nextPageToken).toBe('tok-3')
		expect(client.listFiles).toHaveBeenCalledTimes(2)
	})

	it('exactly 5000 files and no more is NOT truncated', async () => {
		const files = Array.from({ length: RECURSIVE_MAX_FILES }, (_, i) => ({
			id: `f${i}`,
			name: `f${i}`,
			mimeType: 'text/plain',
		}))
		const client: DriveClient = { listFiles: vi.fn().mockResolvedValue({ files }) }
		const out = await listFolder({ ...ctx, client }, { folderId: 'exact', recursive: true })
		expect(out.files).toHaveLength(RECURSIVE_MAX_FILES)
		expect(out.truncated).toBeUndefined()
	})

	it('stops after 5 levels and reports truncated true', async () => {
		// Every folder holds exactly one subfolder, forever.
		const client: DriveClient = {
			listFiles: vi.fn(async (_tok, q) => {
				const parent = /^'(.+)' in parents/.exec(q.q)?.[1] ?? '?'
				return {
					files: [
						{
							id: `${parent}>`,
							name: 'child',
							mimeType: 'application/vnd.google-apps.folder',
						},
					],
				}
			}),
		}
		const out = await listFolder({ ...ctx, client }, { folderId: 'r', recursive: true })

		expect(out.files).toHaveLength(RECURSIVE_MAX_DEPTH)
		expect(client.listFiles).toHaveBeenCalledTimes(RECURSIVE_MAX_DEPTH)
		expect(out.truncated).toBe(true)
	})

	it('a shortcut cycle back to the root terminates', async () => {
		const client: DriveClient = {
			listFiles: vi.fn().mockResolvedValue({
				files: [
					{
						id: 'loop',
						name: 'back to root',
						mimeType: 'application/vnd.google-apps.shortcut',
						shortcutDetails: {
							targetId: 'root',
							targetMimeType: 'application/vnd.google-apps.folder',
						},
					},
				],
			}),
		}
		const out = await listFolder({ ...ctx, client }, { folderId: 'root', recursive: true })
		expect(out.files).toHaveLength(1)
		expect(client.listFiles).toHaveBeenCalledTimes(1)
		expect(out.truncated).toBeUndefined()
	})
})
