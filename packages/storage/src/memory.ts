import { Readable } from 'node:stream'
import type { StorageProvider } from './interface'

// In-process file store. Holds blobs in a Map keyed by storage path. Intended
// for environments that need a working StorageProvider without an S3 backend
// (CI e2e job, integration tests that don't stub storage themselves) — data
// lives for the lifetime of the process and is discarded on exit.
export class MemoryStorageProvider implements StorageProvider {
	private store = new Map<string, Buffer>()

	async ensureBucket(): Promise<void> {}

	async put(key: string, data: Buffer | Uint8Array | Readable): Promise<void> {
		if (data instanceof Readable) {
			const chunks: Buffer[] = []
			for await (const chunk of data) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
			}
			this.store.set(key, Buffer.concat(chunks))
			return
		}
		this.store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data))
	}

	async get(key: string): Promise<Buffer> {
		const value = this.store.get(key)
		if (!value) throw new Error(`Object not found: ${key}`)
		return value
	}

	async list(prefix: string): Promise<string[]> {
		return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix))
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key)
	}

	async exists(key: string): Promise<boolean> {
		return this.store.has(key)
	}
}
