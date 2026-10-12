import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { WormSnapshotStore } from '../worm-snapshot-store'

class AwsError extends Error {
	constructor(name: string) {
		super(name)
		this.name = name
	}
}

type Handler = (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown

function storeWith(handler: Handler) {
	const sent: Array<{ name: string; input: Record<string, unknown> }> = []
	const client = {
		async send(command: Parameters<Handler>[0]) {
			sent.push({ name: command.constructor.name, input: command.input })
			return handler(command)
		},
	} as unknown as S3Client
	return { store: new WormSnapshotStore({ bucket: 'worm-bucket', client }), sent }
}

const KEY = 'snapshots/ws-1/2026-10-12.json'

describe('WormSnapshotStore.exists', () => {
	it('is false when the listing is empty (a missing key lists as 200 with nothing)', async () => {
		const { store, sent } = storeWith(() => ({ Contents: undefined }))
		expect(await store.exists(KEY)).toBe(false)
		expect(sent[0]).toEqual({
			name: 'ListObjectsV2Command',
			input: { Bucket: 'worm-bucket', Prefix: KEY },
		})
	})

	it('is true when a listed Key equals the key exactly', async () => {
		const { store } = storeWith(() => ({ Contents: [{ Key: KEY }] }))
		expect(await store.exists(KEY)).toBe(true)
	})

	it('is false when the prefix only matches a longer key', async () => {
		const { store } = storeWith(() => ({ Contents: [{ Key: `${KEY}.bak` }, { Key: `${KEY}x` }] }))
		expect(await store.exists(KEY)).toBe(false)
	})

	it('is true when the exact key is listed alongside longer ones', async () => {
		const { store } = storeWith(() => ({ Contents: [{ Key: KEY }, { Key: `${KEY}.bak` }] }))
		expect(await store.exists(KEY)).toBe(true)
	})

	it('throws on a 403 instead of reading it as absent', async () => {
		const { store } = storeWith(() => {
			throw new AwsError('AccessDenied')
		})
		await expect(store.exists(KEY)).rejects.toThrow('AccessDenied')
	})

	it('never uses HeadObject', async () => {
		const { store, sent } = storeWith(() => ({ Contents: [] }))
		await store.exists(KEY)
		expect(sent.map((s) => s.name)).not.toContain('HeadObjectCommand')
	})
})

describe('WormSnapshotStore.list', () => {
	it('follows continuation tokens', async () => {
		let page = 0
		const { store } = storeWith(() => {
			page++
			return page === 1
				? { Contents: [{ Key: 'a' }], IsTruncated: true, NextContinuationToken: 't1' }
				: { Contents: [{ Key: 'b' }], IsTruncated: false }
		})
		expect(await store.list('snapshots/ws-1/')).toEqual(['a', 'b'])
	})
})

describe('WormSnapshotStore.putIfAbsent', () => {
	it('sends a conditional PUT with no retention headers', async () => {
		const { store, sent } = storeWith(() => ({}))
		expect(await store.putIfAbsent(KEY, '{"a":1}')).toBe(true)
		expect(sent).toHaveLength(1)
		expect(sent[0]?.name).toBe('PutObjectCommand')
		expect(sent[0]?.input).toMatchObject({ Bucket: 'worm-bucket', Key: KEY, IfNoneMatch: '*' })
		expect(sent[0]?.input).not.toHaveProperty('ObjectLockMode')
		expect(sent[0]?.input).not.toHaveProperty('ObjectLockRetainUntilDate')
	})

	it('returns false when S3 refuses because the key exists, without retrying', async () => {
		const { store, sent } = storeWith(() => {
			throw new AwsError('PreconditionFailed')
		})
		expect(await store.putIfAbsent(KEY, '{}')).toBe(false)
		expect(sent).toHaveLength(1)
	})

	it('throws on any other error, without retrying', async () => {
		const { store, sent } = storeWith(() => {
			throw new AwsError('AccessDenied')
		})
		await expect(store.putIfAbsent(KEY, '{}')).rejects.toThrow('AccessDenied')
		expect(sent).toHaveLength(1)
	})
})

describe('WormSnapshotStore.get', () => {
	it('returns the object text', async () => {
		const { store } = storeWith(() => ({ Body: { transformToString: async () => '{"x":1}' } }))
		expect(await store.get(KEY)).toBe('{"x":1}')
	})

	it('returns null for NoSuchKey and throws for anything else', async () => {
		const missing = storeWith(() => {
			throw new AwsError('NoSuchKey')
		})
		expect(await missing.store.get(KEY)).toBeNull()
		const denied = storeWith(() => {
			throw new AwsError('AccessDenied')
		})
		await expect(denied.store.get(KEY)).rejects.toThrow('AccessDenied')
	})
})

describe('WormSnapshotStore never deletes', () => {
	it('has no delete or retention method', () => {
		const { store } = storeWith(() => ({}))
		const names = Object.getOwnPropertyNames(Object.getPrototypeOf(store))
		for (const name of names) expect(name).not.toMatch(/delete|remove|retention|bypass/i)
	})
})
