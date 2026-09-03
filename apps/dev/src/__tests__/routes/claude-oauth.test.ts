import { createHash } from 'node:crypto'
import { vi } from 'vitest'

vi.mock('../../lib/claude-oauth', () => ({
	encryptOAuthTokens: vi.fn().mockImplementation((tokens: { nickname?: string }) => ({
		encryptedAccessToken: 'enc-access',
		encryptedRefreshToken: 'enc-refresh',
		expiresAt: 1_800_000_000_000,
		subscriptionType: 'pro',
		nickname: tokens.nickname,
	})),
	getValidOAuthToken: vi.fn(),
}))

import { getValidOAuthToken } from '../../lib/claude-oauth'
import { buildWorkspace, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: claudeOauthRoutes } = await import('../../routes/claude-oauth')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

const mockGetValid = getValidOAuthToken as ReturnType<typeof vi.fn>

function expectedFingerprint(accessToken: string, refreshToken: string) {
	return createHash('sha256').update(`${accessToken}:${refreshToken}`).digest('hex').slice(0, 8)
}

const legacyOAuth = {
	encryptedAccessToken: 'legacy-access',
	encryptedRefreshToken: 'legacy-refresh',
	expiresAt: 1_800_000_000_000,
	subscriptionType: 'pro',
}

const newShapeOAuth = (overrides: Record<string, unknown> = {}) => ({
	primary: {
		encryptedAccessToken: 'primary-access',
		encryptedRefreshToken: 'primary-refresh',
		expiresAt: 1_800_000_000_000,
		subscriptionType: 'max-5x',
	},
	backup: {
		encryptedAccessToken: 'backup-access',
		encryptedRefreshToken: 'backup-refresh',
		expiresAt: 1_900_000_000_000,
		subscriptionType: 'pro',
	},
	...overrides,
})

describe('Claude OAuth Routes', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// ── DELETE ──────────────────────────────────────────────────────────────

	describe('DELETE /api/claude-oauth', () => {
		it('drops the entire claude_oauth key when no slot is specified (back-compat)', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: newShapeOAuth() } })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonRequest('DELETE', '/api/claude-oauth', undefined, headers))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ success: true })
			const update = calls.updates[0] as { settings: Record<string, unknown> }
			expect(update.settings).not.toHaveProperty('claude_oauth')
		})

		it('clears only the named slot and preserves the other', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: newShapeOAuth() } })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonDelete('/api/claude-oauth?slot=backup', headers))

			expect(res.status).toBe(200)
			const update = calls.updates[0] as {
				settings: { claude_oauth: { primary?: unknown; backup?: unknown } }
			}
			expect(update.settings.claude_oauth.primary).toBeDefined()
			expect(update.settings.claude_oauth.backup).toBeUndefined()
		})

		it('drops the claude_oauth key when clearing the only remaining slot', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { primary: newShapeOAuth().primary } },
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonDelete('/api/claude-oauth?slot=primary', headers))

			expect(res.status).toBe(200)
			const update = calls.updates[0] as { settings: Record<string, unknown> }
			expect(update.settings).not.toHaveProperty('claude_oauth')
		})

		it('repoints active_slot to the remaining slot when the active slot is disconnected', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: newShapeOAuth({
						failover: { active_slot: 'backup', last_classified_reason: 'quota_exhausted_weekly' },
					}),
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonDelete('/api/claude-oauth?slot=backup', headers))

			expect(res.status).toBe(200)
			const update = calls.updates[0] as {
				settings: {
					claude_oauth: { failover: { active_slot: string; last_classified_reason?: string } }
				}
			}
			expect(update.settings.claude_oauth.failover.active_slot).toBe('primary')
			expect(update.settings.claude_oauth.failover.last_classified_reason).toBeUndefined()
		})

		it('repoints active_slot to backup when the default-active primary is disconnected', async () => {
			// No explicit `failover` on the row — active_slot defaults to 'primary'.
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: newShapeOAuth() } })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonDelete('/api/claude-oauth?slot=primary', headers))

			expect(res.status).toBe(200)
			const update = calls.updates[0] as {
				settings: { claude_oauth: { failover: { active_slot: string } } }
			}
			expect(update.settings.claude_oauth.failover.active_slot).toBe('backup')
		})

		it('leaves active_slot untouched when disconnecting a slot that was not active', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: newShapeOAuth({
						failover: { active_slot: 'backup', last_classified_reason: 'quota_exhausted_weekly' },
					}),
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonDelete('/api/claude-oauth?slot=primary', headers))

			expect(res.status).toBe(200)
			const update = calls.updates[0] as {
				settings: {
					claude_oauth: { failover: { active_slot: string; last_classified_reason?: string } }
				}
			}
			expect(update.settings.claude_oauth.failover.active_slot).toBe('backup')
			// The failure record belonged to the primary, which no longer
			// exists — it goes with it, so the settings page can't report a
			// disconnected credential as unhealthy.
			expect(update.settings.claude_oauth.failover.last_classified_reason).toBeUndefined()
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			const res = await app.request(jsonRequest('DELETE', '/api/claude-oauth', undefined, headers))
			expect(res.status).toBe(403)
		})

		it('drops claude_oauth entirely when disconnecting a legacy primary-only row', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: {
						encryptedAccessToken: 'legacy-access',
						encryptedRefreshToken: 'legacy-refresh',
						expiresAt: 111,
					},
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonRequest('DELETE', '/api/claude-oauth', undefined, headers))

			expect(res.status).toBe(200)
			const [updatePayload] = calls.updates as Array<{ settings: { claude_oauth?: unknown } }>
			expect(updatePayload.settings.claude_oauth).toBeUndefined()
		})
	})

	// ── STATUS ──────────────────────────────────────────────────────────────

	describe('GET /api/claude-oauth/status', () => {
		it('returns connected/valid plus per-slot info and the active slot', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: newShapeOAuth() } })
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]
			mockGetValid.mockResolvedValue({
				tokens: { subscriptionType: 'max-5x', expiresAt: 1_800_000_000_000 },
			})

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.connected).toBe(true)
			expect(body.valid).toBe(true)
			expect(body.active_slot).toBe('primary')
			expect(body.slots.primary).toEqual({
				slot: 'primary',
				position: 0,
				subscription_type: 'max-5x',
				expires_at: 1_800_000_000_000,
				fingerprint: expectedFingerprint('primary-access', 'primary-refresh'),
			})
			expect(body.slots.backup).toEqual({
				slot: 'backup',
				position: 1,
				subscription_type: 'pro',
				expires_at: 1_900_000_000_000,
				fingerprint: expectedFingerprint('backup-access', 'backup-refresh'),
			})
			expect(body.chain).toEqual(['primary', 'backup'])
			expect(body.slots_remaining).toBe(8)
		})

		it('surfaces failover state when active_slot=backup with a classified reason', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: newShapeOAuth({
						failover: {
							active_slot: 'backup',
							last_primary_failure_at: 1_700_000_000_000,
							last_classified_reason: 'quota_exhausted_weekly',
						},
					}),
				},
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]
			mockGetValid.mockResolvedValue({
				tokens: { subscriptionType: 'pro', expiresAt: 1_900_000_000_000 },
			})

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))
			const body = await res.json()
			expect(body.active_slot).toBe('backup')
			expect(body.last_classified_reason).toBe('quota_exhausted_weekly')
			expect(body.last_primary_failure_at).toBe(1_700_000_000_000)
		})

		it('treats a legacy single-slot row as primary-only', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: legacyOAuth },
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]
			mockGetValid.mockResolvedValue({
				tokens: { subscriptionType: 'pro', expiresAt: 1_800_000_000_000 },
			})

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))
			const body = await res.json()
			expect(body.connected).toBe(true)
			expect(body.slots.primary).toBeDefined()
			expect(body.slots.backup).toBeUndefined()
			expect(body.active_slot).toBe('primary')
		})

		it('returns the empty shape when no oauth data is configured', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: {} })
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))
			const body = await res.json()
			expect(body).toEqual({
				connected: false,
				valid: false,
				slots: {},
				chain: [],
				slots_remaining: 10,
				active_slot: 'primary',
			})
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))
			expect(res.status).toBe(403)
		})

		it('surfaces a nickname when the slot has one', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: newShapeOAuth({
						primary: { ...newShapeOAuth().primary, nickname: 'Work account' },
					}),
				},
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]
			mockGetValid.mockResolvedValue({
				tokens: { subscriptionType: 'max-5x', expiresAt: 1_800_000_000_000 },
			})

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))
			const body = await res.json()
			expect(body.slots.primary.nickname).toBe('Work account')
			expect(body.slots.backup.nickname).toBeUndefined()
		})
	})

	// ── IMPORT ──────────────────────────────────────────────────────────────

	describe('POST /api/claude-oauth/import', () => {
		const baseImport = {
			accessToken: 'access-123',
			refreshToken: 'refresh-123',
			expiresAt: 1_800_000_000_000,
		}

		it('writes to the primary slot by default', async () => {
			const workspace = buildWorkspace({ id: wsId })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/import', baseImport, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.slot).toBe('primary')
			const update = calls.updates[0] as {
				settings: { claude_oauth: { primary?: unknown; backup?: unknown } }
			}
			expect(update.settings.claude_oauth.primary).toBeDefined()
			expect(update.settings.claude_oauth.backup).toBeUndefined()
		})

		it('writes to the backup slot when the caller designates backup (AC-U5)', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { primary: newShapeOAuth().primary } },
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/import', { ...baseImport, slot: 'backup' }, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.slot).toBe('backup')
			const update = calls.updates[0] as {
				settings: { claude_oauth: { primary?: unknown; backup?: unknown } }
			}
			expect(update.settings.claude_oauth.primary).toBeDefined()
			expect(update.settings.claude_oauth.backup).toBeDefined()
		})

		it('resets failover state on import so the next session-start re-evaluates', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: newShapeOAuth({
						failover: {
							active_slot: 'backup',
							last_classified_reason: 'auth_failed',
						},
					}),
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			await app.request(jsonRequest('POST', '/api/claude-oauth/import', baseImport, headers))

			const update = calls.updates[0] as {
				settings: { claude_oauth: { failover: { active_slot: string } } }
			}
			expect(update.settings.claude_oauth.failover.active_slot).toBe('primary')
		})

		it('keeps active_slot on backup when re-importing backup while primary is still unhealthy', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: newShapeOAuth({
						failover: { active_slot: 'backup', last_classified_reason: 'quota_exhausted_weekly' },
					}),
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			await app.request(
				jsonRequest('POST', '/api/claude-oauth/import', { ...baseImport, slot: 'backup' }, headers),
			)

			const update = calls.updates[0] as {
				settings: {
					claude_oauth: { failover: { active_slot: string; last_classified_reason?: string } }
				}
			}
			// Importing into backup should NOT force session-start back onto the
			// still-broken primary by resetting active_slot to 'primary'...
			expect(update.settings.claude_oauth.failover.active_slot).toBe('backup')
			// ...nor erase WHY the primary is still broken. Failure records are
			// per slot now, so replacing one credential leaves the others'
			// history (and their recovery cooldowns) intact.
			expect(update.settings.claude_oauth.failover.last_classified_reason).toBe(
				'quota_exhausted_weekly',
			)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/import', baseImport, headers),
			)
			expect(res.status).toBe(403)
		})

		it('stores an optional nickname alongside the tokens', async () => {
			const workspace = buildWorkspace({ id: wsId })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/claude-oauth/import',
					{ ...baseImport, nickname: 'Work account' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.nickname).toBe('Work account')
			const update = calls.updates[0] as {
				settings: { claude_oauth: { primary: { nickname?: string } } }
			}
			expect(update.settings.claude_oauth.primary.nickname).toBe('Work account')
		})

		it('rejects a nickname over 60 characters', async () => {
			const workspace = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/claude-oauth/import',
					{ ...baseImport, nickname: 'x'.repeat(61) },
					headers,
				),
			)
			expect(res.status).toBe(400)
		})
	})

	// ── SWAP ────────────────────────────────────────────────────────────────

	describe('POST /api/claude-oauth/swap', () => {
		it('swaps slot data so what was backup becomes primary', async () => {
			const oauth = newShapeOAuth()
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: oauth } })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/swap', undefined, headers),
			)

			expect(res.status).toBe(200)
			const update = calls.updates[0] as {
				settings: {
					claude_oauth: {
						primary: { encryptedAccessToken: string }
						backup: { encryptedAccessToken: string }
						failover: { active_slot: string }
					}
				}
			}
			expect(update.settings.claude_oauth.primary.encryptedAccessToken).toBe('backup-access')
			expect(update.settings.claude_oauth.backup.encryptedAccessToken).toBe('primary-access')
			expect(update.settings.claude_oauth.failover.active_slot).toBe('primary')
		})

		it('returns 400 if either slot is missing', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { primary: newShapeOAuth().primary } },
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/swap', undefined, headers),
			)
			expect(res.status).toBe(400)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/swap', undefined, headers),
			)
			expect(res.status).toBe(403)
		})
	})

	// ── NICKNAME ────────────────────────────────────────────────────────────

	describe('PATCH /api/claude-oauth/nickname', () => {
		it('sets a nickname on the named slot without touching its tokens', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: newShapeOAuth() } })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/claude-oauth/nickname',
					{ slot: 'primary', nickname: 'Work account' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const update = calls.updates[0] as {
				settings: { claude_oauth: { primary: { encryptedAccessToken: string; nickname?: string } } }
			}
			expect(update.settings.claude_oauth.primary.nickname).toBe('Work account')
			expect(update.settings.claude_oauth.primary.encryptedAccessToken).toBe('primary-access')
		})

		it('trims whitespace before saving', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: newShapeOAuth() } })
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			await app.request(
				jsonRequest(
					'PATCH',
					'/api/claude-oauth/nickname',
					{ slot: 'primary', nickname: '  Work account  ' },
					headers,
				),
			)

			const update = calls.updates[0] as {
				settings: { claude_oauth: { primary: { nickname?: string } } }
			}
			expect(update.settings.claude_oauth.primary.nickname).toBe('Work account')
		})

		it('clears the nickname when given an empty string', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: newShapeOAuth({
						primary: { ...newShapeOAuth().primary, nickname: 'Old name' },
					}),
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			await app.request(
				jsonRequest(
					'PATCH',
					'/api/claude-oauth/nickname',
					{ slot: 'primary', nickname: '' },
					headers,
				),
			)

			const update = calls.updates[0] as {
				settings: { claude_oauth: { primary: { nickname?: string } } }
			}
			expect(update.settings.claude_oauth.primary.nickname).toBeUndefined()
		})

		it('rejects a nickname over 60 characters', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: { claude_oauth: newShapeOAuth() } })
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/claude-oauth/nickname',
					{ slot: 'primary', nickname: 'x'.repeat(61) },
					headers,
				),
			)
			expect(res.status).toBe(400)
		})

		it('returns 404 when the target slot has no credentials', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { primary: newShapeOAuth().primary } },
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/claude-oauth/nickname',
					{ slot: 'backup', nickname: 'Backup account' },
					headers,
				),
			)
			expect(res.status).toBe(404)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/claude-oauth/nickname',
					{ slot: 'primary', nickname: 'Work account' },
					headers,
				),
			)
			expect(res.status).toBe(403)
		})
	})
})
