import { ProvenanceStrip } from '@/components/files/provenance-strip'
import type { AttachingObject } from '@/lib/viewer-provenance'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../setup'

// Each of the 6 provenance variants + the agent-attached-human-driver special
// gets a rendered-tree test here. `resolveProvenance` (the pure function) is
// covered exhaustively in `viewer-provenance.test.ts` — this file covers only
// the visual contract: the strip is (or isn't) present, carries the right
// label, and its crumb/link maps to the right target object.

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		to,
		params,
		className,
		...rest
	}: {
		children: ReactNode
		to?: string
		params?: Record<string, string>
		className?: string
	}) => (
		<a
			href={
				to && params ? Object.entries(params).reduce((s, [k, v]) => s.replace(`$${k}`, v), to) : to
			}
			className={className}
			{...rest}
		>
			{children}
		</a>
	),
}))

function makeAttacher(overrides: Partial<AttachingObject> = {}): AttachingObject {
	return {
		id: 'obj-1',
		title: 'Q3 Review',
		type: 'bet',
		driverId: 'actor-h1',
		driverType: 'human',
		attacherName: 'Sebk',
		attachedAt: '2026-09-01T09:00:00.000Z',
		targetArchived: false,
		archived: false,
		...overrides,
	}
}

function renderStrip(props: {
	attachers: AttachingObject[]
	selectedTargetId?: string | null
	onSelectTarget?: (id: string | null) => void
}) {
	const queryClient = createTestQueryClient()
	return render(
		<QueryClientProvider client={queryClient}>
			<ProvenanceStrip
				workspaceId="ws-1"
				attachers={props.attachers}
				selectedTargetId={props.selectedTargetId ?? null}
				onSelectTarget={props.onSelectTarget ?? (() => {})}
			/>
		</QueryClientProvider>,
	)
}

describe('ProvenanceStrip — 6 variants + agent-driver special', () => {
	it('variant 4 (zero) — strip does not render (direct link)', () => {
		const { container } = renderStrip({ attachers: [] })
		expect(container.querySelector('[data-viewer-provenance-strip]')).toBeNull()
	})

	it('variant 1 (single) — renders crumb + attacher name', () => {
		const only = makeAttacher({ id: 'bet-42', title: 'Onboarding cleanup' })
		renderStrip({ attachers: [only] })
		expect(screen.getByText('Onboarding cleanup')).toBeInTheDocument()
		expect(screen.getByText('Sebk')).toBeInTheDocument()
	})

	it('variant 2 (pair) — renders both attachers with a Switch context button', () => {
		const a = makeAttacher({
			id: 'a',
			title: 'Alpha',
			attachedAt: '2026-09-01T00:00:00.000Z',
		})
		const b = makeAttacher({
			id: 'b',
			title: 'Beta',
			attachedAt: '2026-09-02T00:00:00.000Z',
		})
		renderStrip({ attachers: [a, b] })
		expect(screen.getByText('Beta')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /switch context to alpha/i })).toBeInTheDocument()
	})

	it('variant 3 (many) — renders a picker labeled with the option count', () => {
		const attachers = ['A', 'B', 'C'].map((n) => makeAttacher({ id: n, title: n }))
		renderStrip({ attachers })
		expect(
			screen.getByRole('button', { name: /pick target object for the review round/i }),
		).toHaveTextContent(/3 objects/)
	})

	it('variant 5 (archived) — muted, labels the attacher as archived, no send', () => {
		const archived = makeAttacher({ archived: true, title: 'Stale bet' })
		const { container } = renderStrip({ attachers: [archived] })
		const strip = container.querySelector('[data-viewer-provenance-strip]')
		expect(strip?.getAttribute('data-variant')).toBe('archived')
		expect(screen.getByText(/Attached to \(archived\):/)).toBeInTheDocument()
	})

	it('variant 6 (orphaned) — labels the attacher as orphaned + re-attach', () => {
		const orphan = makeAttacher({ targetArchived: true, title: 'Removed bet' })
		const { container } = renderStrip({ attachers: [orphan] })
		const strip = container.querySelector('[data-viewer-provenance-strip]')
		expect(strip?.getAttribute('data-variant')).toBe('orphaned')
		expect(screen.getByText(/Orphaned:/)).toBeInTheDocument()
		expect(screen.getByText(/re-attach/i)).toBeInTheDocument()
	})

	it('agent-attached-human-driver special — no agent marker when driver is human', () => {
		const humanDriver = makeAttacher({ driverType: 'human' })
		renderStrip({ attachers: [humanDriver] })
		expect(screen.queryByTestId('strip-agent-driver-marker')).toBeNull()
	})

	it('single attacher with agent driver — agent marker rendered', () => {
		const agentDriver = makeAttacher({ driverType: 'agent', title: 'Agent-owned bet' })
		renderStrip({ attachers: [agentDriver] })
		expect(screen.getByTestId('strip-agent-driver-marker')).toBeInTheDocument()
	})
})
