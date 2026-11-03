import { LoopFirstRunBanner, describeFirstFire } from '@/components/loops/loop-first-run-banner'
import type { TriggerResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function buildTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: 't-1',
		workspaceId: 'ws-1',
		name: 'Nightly sweep',
		type: 'cron',
		targetActorId: 'actor-1',
		config: { expression: '0 3 * * *' },
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	} as TriggerResponse
}

describe('describeFirstFire', () => {
	it('derives the first fire from a cron trigger', () => {
		expect(describeFirstFire([buildTrigger()])).toMatch(/^runs /)
	})

	it('derives the first fire from an event trigger', () => {
		const trigger = buildTrigger({
			type: 'event',
			config: { entity_type: 'insight', action: 'created' },
		})
		expect(describeFirstFire([trigger])).toBe('when insight is created')
	})

	it('prefers an enabled trigger over a paused one', () => {
		const off = buildTrigger({ id: 't-off', enabled: false })
		const on = buildTrigger({
			id: 't-on',
			type: 'event',
			config: { entity_type: 'bet', action: 'created' },
		})
		expect(describeFirstFire([off, on])).toBe('when bet is created')
	})

	it('says a trigger is still needed when the loop has none', () => {
		expect(describeFirstFire([])).toBe('as soon as a trigger is attached to it')
	})
})

describe('LoopFirstRunBanner', () => {
	it('states nothing has fired yet and when the first cycle opens', () => {
		render(<LoopFirstRunBanner triggers={[buildTrigger()]} />)
		expect(screen.getByText(/Built from what you said — nothing has fired yet/)).toBeInTheDocument()
		expect(screen.getByText(/The first cycle opens/)).toBeInTheDocument()
	})
})
