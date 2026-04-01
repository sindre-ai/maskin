import type { Readable } from 'node:stream'
import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { StorageProvider } from './interface'

export interface S3StorageConfig {
	endpoint: string
	bucket: string
	accessKeyId: string
	secretAccessKey: string
	region?: string
}

export class S3StorageProvider implements StorageProvider {
	private client: S3Client
	private bucket: string

	constructor(config: S3StorageConfig) {
		this.bucket = config.bucket
		this.client = new S3Client({
			endpoint: config.endpoint,
			region: config.region ?? 'us-east-1',
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
			forcePathStyle: true,
		})
	}

	async ensureBucket(): Promise<void> {
		try {
			await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
		} catch {
			await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
		}
	}

	async put(key: string, data: Buffer | Uint8Array | Readable): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: data,
			}),
		)
	}

	async getUrl(key: string, expiresInSeconds = 3600): Promise<string> {
		const command = new GetObjectCommand({
			Bucket: this.bucket,
			Key: key,
		})
		return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds })
	}

	async get(key: string): Promise<Buffer> {
		const response = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		)
		const bytes = await response.Body?.transformToByteArray()
		if (!bytes) throw new Error(`Empty response for key: ${key}`)
		return Buffer.from(bytes)
	}

	async list(prefix: string): Promise<string[]> {
		const keys: string[] = []
		let continuationToken: string | undefined

		do {
			const response = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
			)
			for (const obj of response.Contents ?? []) {
				if (obj.Key) keys.push(obj.Key)
			}
			continuationToken = response.NextContinuationToken
		} while (continuationToken)

		return keys
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		)
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			)
			return true
		} catch {
			return false
		}
	}
}
