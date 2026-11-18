import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCommentDecision, validateDecisionProse } from '@maskin/shared'
import { YOUTUBE_ACTION_KINDS } from '../../lib/youtube/actions'
import { renderActionBody, renderYoutubeActionCard } from '../../lib/youtube/card'
import { canonicalJson, hashYoutubePayload } from '../../lib/youtube/hash'

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.git', '__tests__', 'drizzle'])
const EXECUTOR = join('apps', 'dev', 'src', 'lib', 'youtube', 'executor.ts')
const CLIENT = join('apps', 'dev', 'src', 'lib', 'youtube', 'google-write-client.ts')
const UPLOAD_CLIENT = join('apps', 'dev', 'src', 'lib', 'youtube', 'google-upload-client.ts')

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path)
		return /\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\./.test(name) ? [path] : []
	})
}

describe('the YouTube write client', () => {
	it('is imported by the executor and by nothing else', () => {
		const files = ['apps', 'packages'].flatMap((top) => sourceFiles(join(REPO_ROOT, top)))
		expect(files.length).toBeGreaterThan(200)

		const reaches = /(?:from|import|require)\s*\(?\s*['"][^'"]*google-write-client(?:\.[a-z]+)?['"]/
		const importers = files
			.filter((file) => reaches.test(readFileSync(file, 'utf8')))
			.map((file) => relative(REPO_ROOT, file))
		expect(importers).toEqual([EXECUTOR])
		expect(readFileSync(join(REPO_ROOT, CLIENT), 'utf8')).toContain(
			'export const googleWriteClient',
		)
	})
})

describe('the YouTube upload client', () => {
	it('is imported by the executor and by nothing else', () => {
		const files = ['apps', 'packages'].flatMap((top) => sourceFiles(join(REPO_ROOT, top)))
		const reaches =
			/(?:from|import|require)\s*\(?\s*['"][^'"]*google-upload-client(?:\.[a-z]+)?['"]/
		const importers = files
			.filter((file) => reaches.test(readFileSync(file, 'utf8')))
			.map((file) => relative(REPO_ROOT, file))
		expect(importers).toEqual([EXECUTOR])
		expect(readFileSync(join(REPO_ROOT, UPLOAD_CLIENT), 'utf8')).toContain(
			'export async function uploadFile',
		)
	})
})

describe('YouTube payload hash', () => {
	it('does not depend on key order and changes when the request changes', () => {
		const a = { id: 'v', snippet: { title: 'T', tags: ['x', 'y'] } }
		const reordered = { snippet: { tags: ['x', 'y'], title: 'T' }, id: 'v' }
		expect(hashYoutubePayload(a)).toBe(hashYoutubePayload(reordered))
		expect(canonicalJson(a)).toBe(canonicalJson(reordered))
		expect(hashYoutubePayload(a)).not.toBe(hashYoutubePayload({ ...a, id: 'w' }))
		expect(hashYoutubePayload(a)).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('YouTube action card', () => {
	const base = {
		payload: { id: 'vid1', rating: 'like' },
		payloadHash: 'h',
		targetVideoId: 'vid1',
		channelLabel: 'Maskin channel',
		agentNote: 'Please approve, it is safe.',
		expiresAt: new Date('2099-01-01T00:00:00Z'),
	}

	it.each(YOUTUBE_ACTION_KINDS)('is a valid decision that follows the house style (%s)', (kind) => {
		const { decision } = renderYoutubeActionCard({ ...base, kind })
		const parsed = parseCommentDecision(decision)
		expect(parsed).not.toBeNull()
		expect(validateDecisionProse(decision, new Date('2026-01-01T00:00:00Z'))).toEqual([])
	})

	it('shows the stored request and keeps the agent note out of the decision', () => {
		const { content, decision } = renderYoutubeActionCard({ ...base, kind: 'like' })
		const shown = JSON.stringify(decision)
		expect(decision.draft?.body).toBe(renderActionBody({ ...base, kind: 'like' }))
		expect(decision.draft?.body).toContain('"rating": "like"')
		expect(shown).not.toContain('Please approve')
		expect(content).toContain("Agent's note")
		expect(content).toContain('Please approve, it is safe.')
	})

	it('shows an upload as private and a schedule with its exact time, from the stored request', () => {
		const upload = renderActionBody({
			...base,
			kind: 'upload_video',
			payload: {
				fileName: 'launch.mp4',
				sizeBytes: 5000,
				containsSyntheticMedia: true,
				privacyStatus: 'private',
			},
			targetVideoId: null,
		})
		expect(upload).toContain('Visibility: PRIVATE')
		expect(upload).toContain('AI generated or altered: yes')
		expect(upload).toContain('launch.mp4 (5000 bytes)')
		const publish = renderActionBody({
			...base,
			kind: 'publish_video',
			payload: { videoId: 'v', privacyStatus: 'private', publishAt: '2026-12-01T09:00:00.000Z' },
		})
		expect(publish).toContain('Goes public at exactly: 2026-12-01T09:00:00.000Z (UTC)')
	})

	it('marks Approve as the destructive option and recommends Reject', () => {
		const { decision } = renderYoutubeActionCard({ ...base, kind: 'like' })
		const approve = decision.options.find((o) => o.label === 'Approve')
		const reject = decision.options.find((o) => o.label === 'Reject')
		expect(approve?.destructive).toBe(true)
		expect(approve?.recommended).toBeUndefined()
		expect(reject?.recommended).toBe(true)
	})
})
