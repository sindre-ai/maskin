import { ViewerStage } from '@/components/files/viewer-stage'
import type { FileDetail } from '@/lib/api'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function buildMediaFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'call.mp3',
		description: null,
		tags: [],
		mimeType: 'audio/mpeg',
		sizeBytes: 100,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content: '',
		encoding: 'base64',
		downloadUrl: 'http://localhost:9000/call.mp3',
		url: 'http://localhost:5173/ws-1/files/file-1',
		annotations: [],
		...overrides,
	}
}

describe('ViewerStage — media', () => {
	// A bare audio element in the flex stage collapsed to 0px wide on desktop, leaving a blank
	// stage. It must keep a width class that is never auto at any breakpoint.
	it('gives the audio player a real width with controls', () => {
		const { container } = render(<ViewerStage file={buildMediaFile()} />)
		const audio = container.querySelector('audio')
		expect(audio).not.toBeNull()
		expect(audio?.hasAttribute('controls')).toBe(true)
		expect(audio?.className).toContain('w-full')
		expect(audio?.className).not.toContain('md:w-auto')
	})

	it('keeps a video sized by its own picture on desktop', () => {
		const { container } = render(
			<ViewerStage file={buildMediaFile({ name: 'clip.mp4', mimeType: 'video/mp4' })} />,
		)
		const video = container.querySelector('video')
		expect(video?.hasAttribute('controls')).toBe(true)
		expect(video?.className).toContain('md:w-auto')
	})
})
