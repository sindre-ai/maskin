import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { S3StorageProvider } from '../s3'

// Real lib-storage Upload; only the S3 client's send() is stubbed so the multipart
// path runs for real and the part bodies are dropped instead of leaving the process.
vi.mock('@aws-sdk/client-s3', async () => {
	const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3')
	return {
		...actual,
		S3Client: vi.fn().mockImplementation(() => ({
			config: { requestChecksumCalculation: async () => 'WHEN_REQUIRED' },
			middlewareStack: { add: vi.fn(), remove: vi.fn() },
			// Plain function, not vi.fn(): a mock would retain every part body in mock.calls.
			send: async (command: { constructor: { name: string } }) => {
				if (command.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'u-1' }
				if (command.constructor.name === 'UploadPartCommand') return { ETag: '"etag"' }
				return {}
			},
		})),
	}
})

const MB = 1024 * 1024
const TOTAL_BYTES = 2 * 1024 * MB
const CHUNK_BYTES = 1 * MB
const MAX_RSS_GROWTH_BYTES = 200 * MB

function syntheticStream(totalBytes: number, onChunk: (bytes: number) => void): Readable {
	const chunk = Buffer.alloc(CHUNK_BYTES, 7)
	return Readable.from(
		(async function* () {
			for (let sent = 0; sent < totalBytes; sent += CHUNK_BYTES) {
				onChunk(CHUNK_BYTES)
				// Fresh copy per chunk, as a real fetch body would hand over.
				yield Buffer.from(chunk)
			}
		})(),
	)
}

describe('S3StorageProvider.put streaming memory bound', () => {
	it('uploads a 2 GB synthetic stream with RSS growth under 200 MB', async () => {
		const provider = new S3StorageProvider({
			endpoint: 'http://localhost:8333',
			bucket: 'test-bucket',
			accessKeyId: 'test-key',
			secretAccessKey: 'test-secret',
		})
		let produced = 0
		const stream = syntheticStream(TOTAL_BYTES, (n) => {
			produced += n
		})

		global.gc?.()
		const baseline = process.memoryUsage().rss
		let peak = baseline
		const sampler = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().rss)
		}, 20)

		try {
			await provider.put('workspaces/w/integrations/google-drive/downloads/f', stream)
		} finally {
			clearInterval(sampler)
			peak = Math.max(peak, process.memoryUsage().rss)
		}

		expect(produced).toBe(TOTAL_BYTES)
		expect(peak - baseline).toBeLessThan(MAX_RSS_GROWTH_BYTES)
	}, 300_000)
})
