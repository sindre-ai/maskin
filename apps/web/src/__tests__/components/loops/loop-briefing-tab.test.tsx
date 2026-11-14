import { LoopBriefingTab } from '@/components/loops/loop-briefing-tab'
import type { FileListItem } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/loops/loop-briefing-stage', () => ({
	LoopBriefingStage: ({ fileId }: { fileId: string }) => <div>stage:{fileId}</div>,
}))

function page(id: string, createdAt: string): FileListItem {
	return {
		id,
		workspaceId: 'w',
		name: `${id}.html`,
		description: null,
		kind: 'briefing',
		tags: [],
		mimeType: 'text/html',
		sizeBytes: 1,
		storageKey: id,
		createdBy: 'a',
		createdAt,
		updatedAt: createdAt,
	}
}

describe('LoopBriefingTab', () => {
	it('opens on the first page (the latest) and offers the older ones in a list', () => {
		render(
			<LoopBriefingTab
				workspaceId="w"
				pages={[page('new', '2026-11-13T08:00:00Z'), page('old', '2026-11-12T08:00:00Z')]}
			/>,
		)
		expect(screen.getByText('stage:new')).toBeInTheDocument()
		expect(screen.getByRole('combobox', { name: 'Briefing version' })).toHaveTextContent(
			/new · .*\(latest\)/,
		)
	})

	it('shows no list when there is only one briefing', () => {
		render(<LoopBriefingTab workspaceId="w" pages={[page('only', '2026-11-13T08:00:00Z')]} />)
		expect(screen.getByText('stage:only')).toBeInTheDocument()
		expect(screen.queryByRole('combobox')).toBeNull()
	})
})
