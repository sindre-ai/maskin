import type { Readable } from 'node:stream'

export interface StorageProvider {
	put(key: string, data: Buffer | Uint8Array | Readable): Promise<void>
	get(key: string): Promise<Buffer>
	getUrl(key: string, expiresInSeconds?: number): Promise<string>
	list(prefix: string): Promise<string[]>
	delete(key: string): Promise<void>
	exists(key: string): Promise<boolean>
	ensureBucket(): Promise<void>
}
