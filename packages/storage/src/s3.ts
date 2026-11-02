import { Readable } from 'node:stream'
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateBucketCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
	CompletedPart,
	PresignDownloadOptions,
	PutOptions,
	StorageProvider,
} from './interface'

export interface S3StorageConfig {
	endpoint: string
	bucket: string
	accessKeyId: string
	secretAccessKey: string
	region?: string
	/**
	 * Address the *browser* uses to reach storage, for presigned URLs. Defaults
	 * to `endpoint`. Set it when the API reaches storage on an internal address
	 * (e.g. http://seaweedfs:8333) that clients cannot resolve.
	 */
	publicEndpoint?: string
}

export class S3StorageProvider implements StorageProvider {
	private client: S3Client
	// Signs URLs for the browser. Separate from `client` because the host is part
	// of the signature, so it has to be the host the browser will actually call.
	private presignClient: S3Client
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
		this.presignClient = new S3Client({
			endpoint: config.publicEndpoint ?? config.endpoint,
			region: config.region ?? 'us-east-1',
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
			forcePathStyle: true,
			// SDK v3 adds a CRC32 checksum header/param by default. A browser cannot
			// compute it for a URL signed ahead of time, and S3-compatible services
			// (Hetzner, SeaweedFS) reject the mismatch. Only sign it where required.
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED',
		})
	}

	async ensureBucket(): Promise<void> {
		try {
			await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
		} catch {
			await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }))
		}
	}

	async put(
		key: string,
		data: Buffer | Uint8Array | Readable,
		options?: PutOptions,
	): Promise<void> {
		if (data instanceof Readable) {
			// Streams of unknown length must use multipart upload — PutObjectCommand
			// would otherwise emit an undefined `x-amz-decoded-content-length` header.
			const upload = new Upload({
				client: this.client,
				params: { Bucket: this.bucket, Key: key, Body: data },
			})
			await upload.done()
			return
		}
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: data,
			}),
			{ abortSignal: options?.signal },
		)
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

	async listWithMetadata(prefix: string): Promise<{ key: string; size: number }[]> {
		const entries: { key: string; size: number }[] = []
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
				if (obj.Key) entries.push({ key: obj.Key, size: obj.Size ?? 0 })
			}
			continuationToken = response.NextContinuationToken
		} while (continuationToken)

		return entries
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		)
	}

	async createMultipartUpload(key: string, options: { contentType: string }): Promise<string> {
		const response = await this.client.send(
			new CreateMultipartUploadCommand({
				Bucket: this.bucket,
				Key: key,
				ContentType: options.contentType,
			}),
		)
		if (!response.UploadId) throw new Error(`No upload id returned for key: ${key}`)
		return response.UploadId
	}

	presignUploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		expiresInSeconds: number,
	): Promise<string> {
		return getSignedUrl(
			this.presignClient,
			new UploadPartCommand({
				Bucket: this.bucket,
				Key: key,
				UploadId: uploadId,
				PartNumber: partNumber,
			}),
			{ expiresIn: expiresInSeconds },
		)
	}

	async completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: CompletedPart[],
	): Promise<void> {
		await this.client.send(
			new CompleteMultipartUploadCommand({
				Bucket: this.bucket,
				Key: key,
				UploadId: uploadId,
				MultipartUpload: {
					Parts: [...parts]
						.sort((a, b) => a.partNumber - b.partNumber)
						.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
				},
			}),
		)
	}

	async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
		await this.client.send(
			new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
		)
	}

	async headObject(key: string): Promise<{ size: number } | null> {
		try {
			const response = await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
			)
			return { size: response.ContentLength ?? 0 }
		} catch (err) {
			const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
			if (status === 404) return null
			throw err
		}
	}

	presignDownload(key: string, options: PresignDownloadOptions): Promise<string> {
		return getSignedUrl(
			this.presignClient,
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: key,
				ResponseContentType: options.contentType,
				ResponseContentDisposition: options.contentDisposition,
			}),
			{ expiresIn: options.expiresInSeconds },
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
