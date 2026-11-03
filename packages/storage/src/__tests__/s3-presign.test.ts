import { describe, expect, it } from 'vitest'
import { S3StorageProvider } from '../s3'

// Presigning is local: it signs with the secret and never calls the network, so
// these use the real S3 client rather than a mock of it.
function provider(publicEndpoint?: string) {
	return new S3StorageProvider({
		endpoint: 'http://seaweedfs:8333',
		publicEndpoint,
		bucket: 'files',
		accessKeyId: 'AKIATEST',
		secretAccessKey: 'secret',
		region: 'nbg1',
	})
}

describe('S3StorageProvider presigned URLs', () => {
	it('signs part uploads for the public endpoint, not the internal one', async () => {
		const url = new URL(
			await provider('https://nbg1.example-storage.com').presignUploadPart(
				'workspaces/w/files/f',
				'upload-1',
				3,
				3600,
			),
		)

		expect(url.origin).toBe('https://nbg1.example-storage.com')
		expect(url.pathname).toBe('/files/workspaces/w/files/f')
		expect(url.searchParams.get('partNumber')).toBe('3')
		expect(url.searchParams.get('uploadId')).toBe('upload-1')
		expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
		expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
	})

	it('falls back to the main endpoint when no public one is set', async () => {
		const url = new URL(await provider().presignUploadPart('k', 'u', 1, 60))

		expect(url.origin).toBe('http://seaweedfs:8333')
	})

	it('does not sign a checksum a browser could not reproduce', async () => {
		const url = await provider().presignUploadPart('k', 'u', 1, 60)

		expect(url.toLowerCase()).not.toContain('checksum')
	})

	it('puts the response type and disposition into a download URL', async () => {
		const url = new URL(
			await provider('https://s3.example.com').presignDownload('k', {
				expiresInSeconds: 600,
				contentType: 'video/mp4',
				contentDisposition: "inline; filename*=UTF-8''clip.mp4",
			}),
		)

		expect(url.searchParams.get('response-content-type')).toBe('video/mp4')
		expect(url.searchParams.get('response-content-disposition')).toBe(
			"inline; filename*=UTF-8''clip.mp4",
		)
		expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
	})
})
