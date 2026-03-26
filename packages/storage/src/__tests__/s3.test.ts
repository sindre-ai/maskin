import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
	S3Client,
	HeadBucketCommand,
	CreateBucketCommand,
	PutObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	DeleteObjectCommand,
	HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { S3StorageProvider } from '../s3'

vi.mock('@aws-sdk/client-s3', async () => {
	const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3')
	return {
		...actual,
		S3Client: vi.fn().mockImplementation(() => ({
			send: vi.fn(),
		})),
	}
})

function getProvider() {
	const provider = new S3StorageProvider({
		endpoint: 'http://localhost:8333',
		bucket: 'test-bucket',
		accessKeyId: 'test-key',
		secretAccessKey: 'test-secret',
	})
	const client = (provider as any).client as { send: ReturnType<typeof vi.fn> }
	const send = client.send
	const getCommand = (callIndex: number) => send.mock.calls[callIndex]![0]!
	return { provider, send, getCommand }
}

describe('S3StorageProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('constructor', () => {
		it('creates S3Client with correct config', () => {
			new S3StorageProvider({
				endpoint: 'http://localhost:8333',
				bucket: 'my-bucket',
				accessKeyId: 'key',
				secretAccessKey: 'secret',
				region: 'eu-west-1',
			})

			expect(S3Client).toHaveBeenCalledWith({
				endpoint: 'http://localhost:8333',
				region: 'eu-west-1',
				credentials: {
					accessKeyId: 'key',
					secretAccessKey: 'secret',
				},
				forcePathStyle: true,
			})
		})

		it('defaults region to us-east-1', () => {
			new S3StorageProvider({
				endpoint: 'http://localhost:8333',
				bucket: 'my-bucket',
				accessKeyId: 'key',
				secretAccessKey: 'secret',
			})

			expect(S3Client).toHaveBeenCalledWith(
				expect.objectContaining({ region: 'us-east-1' }),
			)
		})
	})

	describe('ensureBucket', () => {
		it('does nothing when bucket already exists', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockResolvedValueOnce({})

			await provider.ensureBucket()

			expect(send).toHaveBeenCalledTimes(1)
			expect(getCommand(0)).toBeInstanceOf(HeadBucketCommand)
		})

		it('creates bucket when HeadBucket throws', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockRejectedValueOnce(new Error('NotFound'))
			send.mockResolvedValueOnce({})

			await provider.ensureBucket()

			expect(send).toHaveBeenCalledTimes(2)
			expect(getCommand(0)).toBeInstanceOf(HeadBucketCommand)
			expect(getCommand(1)).toBeInstanceOf(CreateBucketCommand)
		})
	})

	describe('put', () => {
		it('sends PutObjectCommand with Buffer data', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockResolvedValueOnce({})
			const data = Buffer.from('hello')

			await provider.put('my-key', data)

			expect(send).toHaveBeenCalledTimes(1)
			const command = getCommand(0)
			expect(command).toBeInstanceOf(PutObjectCommand)
			expect(command.input).toEqual({
				Bucket: 'test-bucket',
				Key: 'my-key',
				Body: data,
			})
		})

		it('sends PutObjectCommand with Uint8Array data', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockResolvedValueOnce({})
			const data = new Uint8Array([1, 2, 3])

			await provider.put('my-key', data)

			expect(getCommand(0).input.Body).toBe(data)
		})
	})

	describe('get', () => {
		it('returns Buffer from response body', async () => {
			const { provider, send, getCommand } = getProvider()
			const content = Buffer.from('file-content')
			send.mockResolvedValueOnce({
				Body: {
					transformToByteArray: () => Promise.resolve(new Uint8Array(content)),
				},
			})

			const result = await provider.get('my-key')

			expect(result).toBeInstanceOf(Buffer)
			expect(result.toString()).toBe('file-content')
			const command = getCommand(0)
			expect(command).toBeInstanceOf(GetObjectCommand)
			expect(command.input).toEqual({
				Bucket: 'test-bucket',
				Key: 'my-key',
			})
		})

		it('throws when response body is empty', async () => {
			const { provider, send } = getProvider()
			send.mockResolvedValueOnce({ Body: undefined })

			await expect(provider.get('missing-key')).rejects.toThrow(
				'Empty response for key: missing-key',
			)
		})

		it('throws when transformToByteArray returns undefined', async () => {
			const { provider, send } = getProvider()
			send.mockResolvedValueOnce({
				Body: {
					transformToByteArray: () => Promise.resolve(undefined),
				},
			})

			await expect(provider.get('bad-key')).rejects.toThrow(
				'Empty response for key: bad-key',
			)
		})
	})

	describe('list', () => {
		it('returns keys from single-page response', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockResolvedValueOnce({
				Contents: [{ Key: 'prefix/a.txt' }, { Key: 'prefix/b.txt' }],
				NextContinuationToken: undefined,
			})

			const keys = await provider.list('prefix/')

			expect(keys).toEqual(['prefix/a.txt', 'prefix/b.txt'])
			const command = getCommand(0)
			expect(command).toBeInstanceOf(ListObjectsV2Command)
			expect(command.input).toEqual({
				Bucket: 'test-bucket',
				Prefix: 'prefix/',
				ContinuationToken: undefined,
			})
		})

		it('handles pagination across multiple pages', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockResolvedValueOnce({
				Contents: [{ Key: 'a.txt' }],
				NextContinuationToken: 'token-1',
			})
			send.mockResolvedValueOnce({
				Contents: [{ Key: 'b.txt' }],
				NextContinuationToken: undefined,
			})

			const keys = await provider.list('')

			expect(keys).toEqual(['a.txt', 'b.txt'])
			expect(send).toHaveBeenCalledTimes(2)
			expect(getCommand(1).input.ContinuationToken).toBe('token-1')
		})

		it('returns empty array when no contents', async () => {
			const { provider, send } = getProvider()
			send.mockResolvedValueOnce({
				Contents: undefined,
				NextContinuationToken: undefined,
			})

			const keys = await provider.list('empty/')

			expect(keys).toEqual([])
		})

		it('skips objects without Key', async () => {
			const { provider, send } = getProvider()
			send.mockResolvedValueOnce({
				Contents: [{ Key: 'a.txt' }, {}, { Key: 'c.txt' }],
				NextContinuationToken: undefined,
			})

			const keys = await provider.list('')

			expect(keys).toEqual(['a.txt', 'c.txt'])
		})
	})

	describe('delete', () => {
		it('sends DeleteObjectCommand with correct params', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockResolvedValueOnce({})

			await provider.delete('my-key')

			expect(send).toHaveBeenCalledTimes(1)
			const command = getCommand(0)
			expect(command).toBeInstanceOf(DeleteObjectCommand)
			expect(command.input).toEqual({
				Bucket: 'test-bucket',
				Key: 'my-key',
			})
		})
	})

	describe('exists', () => {
		it('returns true when object exists', async () => {
			const { provider, send, getCommand } = getProvider()
			send.mockResolvedValueOnce({})

			const result = await provider.exists('my-key')

			expect(result).toBe(true)
			const command = getCommand(0)
			expect(command).toBeInstanceOf(HeadObjectCommand)
			expect(command.input).toEqual({
				Bucket: 'test-bucket',
				Key: 'my-key',
			})
		})

		it('returns false when HeadObject throws', async () => {
			const { provider, send } = getProvider()
			send.mockRejectedValueOnce(new Error('NotFound'))

			const result = await provider.exists('missing-key')

			expect(result).toBe(false)
		})
	})
})
