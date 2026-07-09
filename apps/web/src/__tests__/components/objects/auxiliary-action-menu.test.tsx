import { AuxiliaryActionMenu } from '@/components/objects/auxiliary-action-menu'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

describe('AuxiliaryActionMenu', () => {
	it('grows the trigger hit area to ≥44px on coarse pointers (WCAG 2.5.5)', () => {
		// OD4: the "..." trigger is h-7 w-7 (28px) — below WCAG 2.5.5 Target Size and
		// the Maskin 44px rule. On coarse-pointer devices it must grow to ≥44×44 CSS
		// pixels via pointer-coarse: variants, without changing the visual glyph.
		const object = buildObjectResponse({ title: 'A bet' })
		render(<AuxiliaryActionMenu object={object} onDeleteRequest={vi.fn()} workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		const trigger = screen.getByRole('button', { name: /more actions/i })
		expect(trigger.className).toContain('pointer-coarse:min-h-11')
		expect(trigger.className).toContain('pointer-coarse:min-w-11')
		// Fine-pointer rendering unchanged: base h-7 w-7 stays.
		expect(trigger.className).toContain('h-7')
		expect(trigger.className).toContain('w-7')
	})
})
