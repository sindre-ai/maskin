import {
	VerifiedChip,
	canStampVerification,
	isKnowledgeAuthorWrite,
	isObjectVerified,
} from '@/components/objects/verified-chip'
import type { MemberResponse } from '@/lib/api'
import { setStoredActor } from '@/lib/auth'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'

function member(overrides: Partial<MemberResponse> & { actorId: string }): MemberResponse {
	return {
		role: 'admin',
		joinedAt: null,
		name: 'Test User',
		type: 'human',
		...overrides,
	}
}

describe('isKnowledgeAuthorWrite', () => {
	it('is true when a knowledge object has "writer" in provenance', () => {
		const obj = buildObjectResponse({
			type: 'knowledge',
			metadata: { provenance: 'writer, claude-sonnet' },
		})
		expect(isKnowledgeAuthorWrite(obj)).toBe(true)
	})

	it('trims and matches case-insensitively', () => {
		const obj = buildObjectResponse({
			type: 'knowledge',
			metadata: { provenance: 'claude-sonnet,  Writer ,human-review' },
		})
		expect(isKnowledgeAuthorWrite(obj)).toBe(true)
	})

	it('is false for non-knowledge types', () => {
		expect(
			isKnowledgeAuthorWrite(
				buildObjectResponse({ type: 'bet', metadata: { provenance: 'writer' } }),
			),
		).toBe(false)
	})

	it('is false when provenance lacks "writer"', () => {
		expect(
			isKnowledgeAuthorWrite(
				buildObjectResponse({ type: 'knowledge', metadata: { provenance: 'human-review' } }),
			),
		).toBe(false)
	})

	it('is false when metadata is missing', () => {
		expect(isKnowledgeAuthorWrite(buildObjectResponse({ type: 'knowledge', metadata: null }))).toBe(
			false,
		)
	})
})

describe('isObjectVerified', () => {
	it('is true when verified_by is a non-empty string', () => {
		expect(isObjectVerified(buildObjectResponse({ metadata: { verified_by: 'actor-123' } }))).toBe(
			true,
		)
	})

	it('is false when verified_by is missing', () => {
		expect(isObjectVerified(buildObjectResponse({ metadata: {} }))).toBe(false)
	})

	it('is false when metadata is null', () => {
		expect(isObjectVerified(buildObjectResponse({ metadata: null }))).toBe(false)
	})
})

describe('canStampVerification', () => {
	beforeEach(() => {
		setStoredActor({ id: 'actor-1', name: 'Alice', type: 'human', email: 'a@x.com' })
	})
	afterEach(() => {
		localStorage.clear()
	})

	it('is true for a human admin', () => {
		expect(canStampVerification([member({ actorId: 'actor-1', role: 'admin' })])).toBe(true)
	})

	it('is true for a human owner', () => {
		expect(canStampVerification([member({ actorId: 'actor-1', role: 'owner' })])).toBe(true)
	})

	it('is false for a plain human member', () => {
		expect(canStampVerification([member({ actorId: 'actor-1', role: 'member' })])).toBe(false)
	})

	it('is false for an agent even with admin role', () => {
		expect(
			canStampVerification([member({ actorId: 'actor-1', role: 'admin', type: 'agent' })]),
		).toBe(false)
	})

	it('is false when the current actor is not a workspace member', () => {
		expect(canStampVerification([member({ actorId: 'actor-999', role: 'owner' })])).toBe(false)
	})

	it('is false when no members list is available', () => {
		expect(canStampVerification(undefined)).toBe(false)
	})
})

describe('VerifiedChip', () => {
	beforeEach(() => {
		setStoredActor({ id: 'actor-1', name: 'Alice', type: 'human', email: 'a@x.com' })
	})
	afterEach(() => {
		localStorage.clear()
	})

	it('renders the unverified state with a stamp control for a human admin', () => {
		const onToggle = vi.fn()
		const obj = buildObjectResponse({
			type: 'knowledge',
			metadata: { provenance: 'writer' },
		})
		render(
			<VerifiedChip
				object={obj}
				members={[member({ actorId: 'actor-1', role: 'admin' })]}
				onToggle={onToggle}
			/>,
		)
		const button = screen.getByRole('button', { name: /not verified/i })
		expect(button).toHaveAttribute('aria-pressed', 'false')
		fireEvent.click(button)
		expect(onToggle).toHaveBeenCalledWith(true)
	})

	it('renders the verified state and toggles off when clicked', () => {
		const onToggle = vi.fn()
		const obj = buildObjectResponse({
			type: 'knowledge',
			metadata: {
				provenance: 'writer',
				verified_by: 'actor-1',
				verified_at: '2026-07-01T00:00:00Z',
			},
		})
		render(
			<VerifiedChip
				object={obj}
				members={[member({ actorId: 'actor-1', role: 'owner' })]}
				onToggle={onToggle}
			/>,
		)
		const button = screen.getByRole('button', { name: /verified — click to remove/i })
		expect(button).toHaveAttribute('aria-pressed', 'true')
		fireEvent.click(button)
		expect(onToggle).toHaveBeenCalledWith(false)
	})

	it('renders a read-only chip (no button) when the caller cannot stamp', () => {
		const onToggle = vi.fn()
		const obj = buildObjectResponse({
			type: 'knowledge',
			metadata: { provenance: 'writer' },
		})
		render(
			<VerifiedChip
				object={obj}
				members={[member({ actorId: 'actor-1', role: 'member' })]}
				onToggle={onToggle}
			/>,
		)
		expect(screen.queryByRole('button')).toBeNull()
		expect(screen.getByText(/unverified/i)).toBeInTheDocument()
	})

	it('renders a read-only chip when the caller is an agent', () => {
		const onToggle = vi.fn()
		const obj = buildObjectResponse({
			type: 'knowledge',
			metadata: {
				provenance: 'writer',
				verified_by: 'actor-99',
				verified_at: '2026-07-01T00:00:00Z',
			},
		})
		render(
			<VerifiedChip
				object={obj}
				members={[member({ actorId: 'actor-1', role: 'admin', type: 'agent' })]}
				onToggle={onToggle}
			/>,
		)
		expect(screen.queryByRole('button')).toBeNull()
		expect(screen.getByText(/verified/i)).toBeInTheDocument()
	})

	it('ignores clicks while the mutation is pending', () => {
		const onToggle = vi.fn()
		const obj = buildObjectResponse({
			type: 'knowledge',
			metadata: { provenance: 'writer' },
		})
		render(
			<VerifiedChip
				object={obj}
				members={[member({ actorId: 'actor-1', role: 'admin' })]}
				onToggle={onToggle}
				isPending
			/>,
		)
		const button = screen.getByRole('button', { name: /not verified/i })
		fireEvent.click(button)
		expect(onToggle).not.toHaveBeenCalled()
	})
})
