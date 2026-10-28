import type { Readable } from 'node:stream'

export interface PutOptions {
	/** Aborts a Buffer upload when fired (streamed uploads ignore it). */
	signal?: AbortSignal
}

export interface StorageProvider {
	put(key: string, data: Buffer | Uint8Array | Readable, options?: PutOptions): Promise<void>
	get(key: string): Promise<Buffer>
	list(prefix: string): Promise<string[]>
	listWithMetadata(prefix: string): Promise<{ key: string; size: number }[]>
	delete(key: string): Promise<void>
	exists(key: string): Promise<boolean>
	ensureBucket(): Promise<void>
}
