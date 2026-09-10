import { vi } from 'vitest'
import type { LinkedInClient } from '../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * R11-A test helper — a fake `LinkedInClient` whose enumeration surface
 * (`getProfile('me')` + `getManagedCompanyPages`) returns the canonical
 * R11-A fixture: 1 personal, 2 admined pages, one messaging-enabled and one
 * publish-only. Every other verb is a bare `vi.fn` — the enumeration tests
 * don't exercise them, and asserting on which mock was called is the fan-out
 * suites' actual concern.
 *
 * Lives under `__helpers/` because both `integrations-linkedin-unipile-fan-out.test.ts`
 * and `integrations-linkedin-unipile-migration.test.ts` use the same fixture,
 * and the tests would drift if a copy sat inside each file.
 */
export function fakeLinkedInClientForTests(): LinkedInClient {
	const stub = <T>(status: number, body: T) =>
		Promise.resolve({ status, body, headers: {} as Record<string, string> })
	return {
		getProfile: vi.fn().mockImplementation(() =>
			stub(200, {
				object: 'UserProfile',
				id: 'seb-suffix',
				provider_id: 'seb-suffix',
				display_name: 'Sebastian Bille',
				first_name: 'Sebastian',
				last_name: 'Bille',
				public_identifier: 'sebastianbille',
			}),
		),
		getManagedCompanyPages: vi.fn().mockImplementation(() =>
			stub(200, {
				object: 'ManagedCompanyPageList',
				data: [
					{
						object: 'ManagedCompanyPage',
						object_urn: 'urn:li:organization:11111',
						public_identifier: 'maskinio',
						name: 'Maskin',
						mailbox_id: 'mailbox-maskinio',
						messaging_enabled: true,
					},
					{
						object: 'ManagedCompanyPage',
						object_urn: 'urn:li:organization:22222',
						public_identifier: 'sample-page',
						name: 'Sample Page',
						mailbox_id: null,
						messaging_enabled: false,
					},
				],
			}),
		),
		sendMessage: vi.fn() as never,
		reply: vi.fn() as never,
		listConversations: vi.fn() as never,
		listMessages: vi.fn() as never,
		listRelations: vi.fn() as never,
		searchPeople: vi.fn() as never,
		sendConnectionRequest: vi.fn() as never,
		publishPost: vi.fn() as never,
		commentOnPost: vi.fn() as never,
		replyToComment: vi.fn() as never,
		readPostComments: vi.fn() as never,
		retrievePost: vi.fn() as never,
		listReactions: vi.fn() as never,
		countComments: vi.fn() as never,
	} as unknown as LinkedInClient
}
