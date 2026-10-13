import {
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'

export interface WormSnapshotStoreConfig {
	bucket: string
	/** The bucket's region. Default eu-central-1. Credentials come from the standard AWS chain. */
	region?: string
	/** Injected in tests. */
	client?: S3Client
}

/**
 * A thin client for the write-once (S3 Object Lock) bucket that holds the daily
 * audit-chain snapshots. Retention is the bucket's default, so nothing here sets or
 * needs PutObjectRetention, and nothing here can delete: an object written wrongly
 * stays for the retention period, which in production is 24 months in Compliance
 * mode. So every method fails loudly and none of them retries.
 *
 * A lookup that fails for ANY reason, 403 included, throws. It is never read as "the
 * key is absent": treating a permission error as absent would write a duplicate.
 */
export class WormSnapshotStore {
	private readonly client: S3Client
	private readonly bucket: string

	constructor(config: WormSnapshotStoreConfig) {
		this.bucket = config.bucket
		this.client = config.client ?? new S3Client({ region: config.region ?? 'eu-central-1' })
	}

	/**
	 * True only when a listed entry's Key equals the key exactly. Lists with the key as
	 * the prefix, never HeadObject: listing a missing key answers 200 with an empty
	 * list, where HeadObject on a bucket without s3:ListBucket would answer 403. A
	 * prefix also matches longer keys, so equality is checked on every entry. An exact
	 * match sorts before any longer key with the same prefix, so the first page is
	 * enough.
	 */
	async exists(key: string): Promise<boolean> {
		const out = await this.client.send(
			new ListObjectsV2Command({ Bucket: this.bucket, Prefix: key }),
		)
		return (out.Contents ?? []).some((o) => o.Key === key)
	}

	/** Every key under a prefix, in S3's order (ascending by key). */
	async list(prefix: string): Promise<string[]> {
		const keys: string[] = []
		let token: string | undefined
		do {
			const out = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: token,
				}),
			)
			for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key)
			token = out.IsTruncated ? out.NextContinuationToken : undefined
		} while (token)
		return keys
	}

	/**
	 * Writes the body unless the key already exists. If-None-Match: * makes S3 itself
	 * refuse a second write, so two runs that both passed exists() cannot both land
	 * (a second PUT on a versioned bucket would add a version that can never be
	 * deleted). Returns false when S3 refused because the key exists.
	 */
	async putIfAbsent(key: string, body: string): Promise<boolean> {
		try {
			await this.client.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: key,
					Body: body,
					ContentType: 'application/json',
					IfNoneMatch: '*',
				}),
			)
			return true
		} catch (err) {
			if (err instanceof Error && err.name === 'PreconditionFailed') {
				return false
			}
			throw err
		}
	}

	/** The object's text, or null when the key does not exist. Any other error throws. */
	async get(key: string): Promise<string | null> {
		try {
			const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
			return (await out.Body?.transformToString()) ?? null
		} catch (err) {
			if (err instanceof Error && err.name === 'NoSuchKey') return null
			throw err
		}
	}
}
