import {
	UndoWriteChip,
	canUndoKnowledgeWrite,
	isKnowledgeAuthorWriteEvent,
	isUndoWindowOpen,
} from '@/components/activity/undo-write-chip'
import type { EventResponse, MemberResponse } from '@/lib/api'
import { setStoredActor } from '@/lib/auth'
import { DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME } from '@maskin/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			workspaces: {
				...actual.api.workspaces,
				members: {
					list: vi.fn(async () => membersFixture),
				},
			},
			objects: {
				...actual.api.objects,
				undoWrite: vi.fn(async () => ({}) as never),
			},
		},
	}
})

let membersFixture: MemberResponse[] = []

function member(overrides: Partial<MemberResponse> & { actorId: string }): MemberResponse {
	return {
		role: 'admin',
		joinedAt: null,
		name: 'Test User',
		type: 'human',
		...overrides,
	}
}

function baseEvent(overrides: Partial<EventResponse> = {}): EventResponse {
	return {
		id: 42,
		workspaceId: 'ws-1',
		actorId: 'actor-ka',
		action: 'updated',
		entityType: 'knowledge',
		entityId: 'obj-1',
		data: { changes: [{ field: 'title', old: 'A', new: 'B' }] },
		createdAt: new Date().toISOString(),
		...overrides,
	}
}

describe('isKnowledgeAuthorWriteEvent', () => {
	it('is true for an updated knowledge event authored by the KA agent', () => {
		expect(
			isKnowledgeAuthorWriteEvent(baseEvent(), {
				type: 'agent',
				name: DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME,
			}),
		).toBe(true)
	})

	it('is true for a status_changed event authored by the KA agent', () => {
		expect(
			isKnowledgeAuthorWriteEvent(baseEvent({ action: 'status_changed' }), {
				type: 'agent',
				name: DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME,
			}),
		).toBe(true)
	})

	it('is false for non-knowledge entity types', () => {
		expect(
			isKnowledgeAuthorWriteEvent(baseEvent({ entityType: 'bet' }), {
				type: 'agent',
				name: DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME,
			}),
		).toBe(false)
	})

	it('is false for created/deleted actions (not field-level undo targets)', () => {
		expect(
			isKnowledgeAuthorWriteEvent(baseEvent({ action: 'created' }), {
				type: 'agent',
				name: DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME,
			}),
		).toBe(false)
	})

	it('is false when the actor is a different agent', () => {
		expect(
			isKnowledgeAuthorWriteEvent(baseEvent(), { type: 'agent', name: 'Some Other Agent' }),
		).toBe(false)
	})

	it('is false when the actor is a human even if the name matches', () => {
		expect(
			isKnowledgeAuthorWriteEvent(baseEvent(), {
				type: 'human',
				name: DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME,
			}),
		).toBe(false)
	})

	it('is false when the actor is missing', () => {
		expect(isKnowledgeAuthorWriteEvent(baseEvent(), undefined)).toBe(false)
	})
})

describe('isUndoWindowOpen', () => {
	const now = Date.parse('2026-07-12T00:00:00Z')

	it('is true within 7 days', () => {
		const created = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString()
		expect(isUndoWindowOpen(created, now)).toBe(true)
	})

	it('is false at exactly 7 days', () => {
		const created = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
		expect(isUndoWindowOpen(created, now)).toBe(false)
	})

	it('is false past 7 days', () => {
		const created = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()
		expect(isUndoWindowOpen(created, now)).toBe(false)
	})

	it('is false for null / unparseable timestamps', () => {
		expect(isUndoWindowOpen(null, now)).toBe(false)
		expect(isUndoWindowOpen('not-a-date', now)).toBe(false)
	})
})

describe('canUndoKnowledgeWrite', () => {
	beforeEach(() => {
		setStoredActor({ id: 'actor-1', name: 'Alice', type: 'human', email: 'a@x.com' })
	})
	afterEach(() => {
		localStorage.clear()
	})

	it('is true for a human admin', () => {
		expect(canUndoKnowledgeWrite([member({ actorId: 'actor-1', role: 'admin' })])).toBe(true)
	})

	it('is true for a human owner', () => {
		expect(canUndoKnowledgeWrite([member({ actorId: 'actor-1', role: 'owner' })])).toBe(true)
	})

	it('is false for a plain member', () => {
		expect(canUndoKnowledgeWrite([member({ actorId: 'actor-1', role: 'member' })])).toBe(false)
	})

	it('is false for an agent even with admin role', () => {
		expect(
			canUndoKnowledgeWrite([member({ actorId: 'actor-1', role: 'admin', type: 'agent' })]),
		).toBe(false)
	})

	it('is false when the stored actor is not a member of the workspace', () => {
		expect(canUndoKnowledgeWrite([member({ actorId: 'other-actor', role: 'admin' })])).toBe(false)
	})

	it('is false with no members list', () => {
		expect(canUndoKnowledgeWrite(undefined)).toBe(false)
	})
})

describe('UndoWriteChip', () => {
	beforeEach(() => {
		setStoredActor({ id: 'actor-1', name: 'Alice', type: 'human', email: 'a@x.com' })
		membersFixture = [member({ actorId: 'actor-1', role: 'admin' })]
	})
	afterEach(() => {
		localStorage.clear()
	})

	const kaActor = { type: 'agent', name: DEV_ACTOR_RETRO_KNOWLEDGE_AUTHOR_NAME }

	it('renders an Undo button for a fresh KA write when caller is admin', async () => {
		render(
			<TestWrapper>
				<UndoWriteChip event={baseEvent()} objectId="obj-1" workspaceId="ws-1" actor={kaActor} />
			</TestWrapper>,
		)
		await waitFor(() =>
			expect(
				screen.getByRole('button', { name: /undo this knowledge author write/i }),
			).toBeInTheDocument(),
		)
	})

	it('renders a read-only chip (no button) for a non-admin viewer', async () => {
		membersFixture = [member({ actorId: 'actor-1', role: 'member' })]
		render(
			<TestWrapper>
				<UndoWriteChip event={baseEvent()} objectId="obj-1" workspaceId="ws-1" actor={kaActor} />
			</TestWrapper>,
		)
		await waitFor(() => expect(screen.getByText('Undo')).toBeInTheDocument())
		expect(screen.queryByRole('button')).toBeNull()
	})

	it('renders nothing when the write is older than 7 days', () => {
		const staleCreated = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
		const { container } = render(
			<TestWrapper>
				<UndoWriteChip
					event={baseEvent({ createdAt: staleCreated })}
					objectId="obj-1"
					workspaceId="ws-1"
					actor={kaActor}
				/>
			</TestWrapper>,
		)
		expect(container.querySelector('button')).toBeNull()
		expect(screen.queryByText('Undo')).toBeNull()
	})

	it('renders nothing when the event is not a KA write', () => {
		const { container } = render(
			<TestWrapper>
				<UndoWriteChip
					event={baseEvent()}
					objectId="obj-1"
					workspaceId="ws-1"
					actor={{ type: 'agent', name: 'Another Agent' }}
				/>
			</TestWrapper>,
		)
		expect(container.querySelector('button')).toBeNull()
		expect(screen.queryByText('Undo')).toBeNull()
	})

	it('calls the undo API when the admin clicks Undo', async () => {
		const { api } = await import('@/lib/api')
		render(
			<TestWrapper>
				<UndoWriteChip event={baseEvent()} objectId="obj-1" workspaceId="ws-1" actor={kaActor} />
			</TestWrapper>,
		)
		const button = await screen.findByRole('button', { name: /undo this knowledge author write/i })
		fireEvent.click(button)
		await waitFor(() => expect(api.objects.undoWrite).toHaveBeenCalledWith('obj-1', 42))
	})
})
