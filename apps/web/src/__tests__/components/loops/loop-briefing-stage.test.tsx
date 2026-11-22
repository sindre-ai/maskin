import { LoopBriefingStage } from '@/components/loops/loop-briefing-stage'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-files', () => ({
	useFile: () => ({
		data: { id: 'f1', name: 'Discovery briefing.html', mimeType: 'text/html' },
		isLoading: false,
		isError: false,
	}),
}))
vi.mock('@/components/files/viewer-stage', () => ({
	ViewerStage: ({ file }: { file: { name: string } }) => <div>stage:{file.name}</div>,
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: React.ReactNode }) => <a href="/file">{children}</a>,
}))

describe('LoopBriefingStage', () => {
	it('shows the briefing in the file viewer with its name and a full-page link', () => {
		render(<LoopBriefingStage workspaceId="w" fileId="f1" />)
		expect(screen.getByRole('heading', { name: 'Discovery briefing' })).toBeInTheDocument()
		expect(screen.getByText('stage:Discovery briefing.html')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open full page/ })).toBeInTheDocument()
	})
})
