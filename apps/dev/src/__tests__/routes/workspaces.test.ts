import { randomUUID } from 'node:crypto'
import { buildCreateWorkspaceBody, buildWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp, createTestApp } from '../setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

describe('Workspaces Routes', () => {
	describe('POST /api/workspaces', () => {
		// Each of the 7 default agents does one actor insert + one
		// workspaceMembers insert inside the create transaction (seedDefaultAgentActors);
		// mockResults.insert is the static fallback once insertQueue is exhausted, so
		// unconfigured agent/member inserts still resolve to a row with an id.
		const defaultAgentInsertFallback = { id: randomUUID() }

		it('creates a workspace and adds the creator as owner, returning 201', async () => {
			const ws = buildWorkspace()
			const { app, mockResults, calls, sessionManager } = createSessionTestApp(
				workspacesRoutes,
				'/api/workspaces',
			)
			mockResults.insertQueue = [
				[ws], // workspaces insert
				[{}], // owner workspaceMembers insert
			]
			mockResults.insert = [defaultAgentInsertFallback]
			// Chief of Staff's welcome session is kicked off fire-and-forget
			// (.catch(), not awaited) right after the transaction commits.
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(ws.id)
			expect(body.name).toBe(ws.name)
			// workspace + owner-member + 7 default agents × (actor + member) = 16.
			expect(calls.inserts).toHaveLength(16)
			expect(calls.inserts[1]).toMatchObject({ workspaceId: ws.id, role: 'owner' })
		})

		it('rejects a caller-supplied settings.billing with 400 and creates nothing', async () => {
			// Regression: PATCH already refused `billing`, but POST accepted the
			// full workspaceSettingsSchema and provisionWorkspace wrote it
			// verbatim — so any actor (or any agent via MCP `create_workspace`)
			// could self-grant `plan: 'team', status: 'active'` at creation time
			// and take the seat cap, the ownership cap and an arbitrary
			// Maskin-funded spend cap without paying Stripe.
			const { app, calls } = createSessionTestApp(workspacesRoutes, '/api/workspaces')

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', {
					...buildCreateWorkspaceBody(),
					settings: {
						billing: {
							plan: 'team',
							status: 'active',
							hard_cap_usd_cents: 100_000_000,
						},
					},
				}),
			)

			expect(res.status).toBe(400)
			expect(calls.inserts).toHaveLength(0)
		})

		it('respects an explicit default_agent_id and does not overwrite it', async () => {
			const explicitAgentId = randomUUID()
			// The mock insert returns this row verbatim (unlike real Postgres, it
			// doesn't reflect what was actually passed to .values()), so build it
			// with the settings the route would have written for this request.
			const ws = buildWorkspace({ settings: { default_agent_id: explicitAgentId } })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				workspacesRoutes,
				'/api/workspaces',
			)
			mockResults.insertQueue = [[ws], [{}]]
			mockResults.insert = [defaultAgentInsertFallback]
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', {
					...buildCreateWorkspaceBody(),
					settings: { default_agent_id: explicitAgentId },
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.settings.default_agent_id).toBe(explicitAgentId)
		})

		it('returns 500 when workspace insert returns empty', async () => {
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insert = [] // empty — insert failed

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toContain('Failed to create workspace')
		})
	})

	describe('GET /api/workspaces', () => {
		it('returns 200 with list of workspaces', async () => {
			const ws = { ...buildWorkspace(), role: 'owner' }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [ws]

			const res = await app.request(jsonGet('/api/workspaces'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
		})
	})

	describe('PATCH /api/workspaces/:id', () => {
		it('returns 200 when workspace updated', async () => {
			const ws = buildWorkspace()
			const updated = { ...ws, name: 'Updated Workspace' }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, { name: 'Updated Workspace' }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when workspace not found for settings merge', async () => {
			const { app } = createTestApp(workspacesRoutes, '/api/workspaces')
			const id = '00000000-0000-0000-0000-000000000099'

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 and does not touch the DB when settings.claude_oauth is present', async () => {
			const ws = buildWorkspace()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.update = [{ ...ws, name: 'should not be used' }]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: {
						claude_oauth: {
							primary: {
								encryptedAccessToken: 'token',
								encryptedRefreshToken: 'refresh',
								expiresAt: 1234567890,
							},
						},
					},
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(calls.updates).toHaveLength(0)
		})

		// Stripe owns settings.billing. Accepting it here would be a free paid
		// plan: unlimited seats, unlimited owned workspaces, a paid spend cap.
		it('returns 400 and does not touch the DB when settings.billing is present', async () => {
			const ws = buildWorkspace()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.update = [{ ...ws }]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { billing: { plan: 'team', status: 'active' } },
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(calls.updates).toHaveLength(0)
		})

		it('rejects settings.billing even when smuggled alongside a legitimate key', async () => {
			const ws = buildWorkspace()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.update = [{ ...ws }]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					name: 'Renamed',
					settings: {
						max_concurrent_sessions: 5,
						billing: { plan: 'team', status: 'active' },
					},
				}),
			)

			expect(res.status).toBe(400)
			expect(calls.updates).toHaveLength(0)
		})
	})

	describe('PATCH /api/workspaces/admin/:id', () => {
		it('returns 200 and seeds prompt rows when owner enables onboarding', async () => {
			const ws = buildWorkspace()
			const updated = { ...ws, onboardingEnabled: true }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[ws], // workspace exists check
				[{ actorId: 'test-actor-id' }], // isWorkspaceOwner → owner row found
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { onboarding_enabled: true }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.onboardingEnabled).toBe(true)
		})

		it('returns 403 when caller is not the workspace owner', async () => {
			const ws = buildWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[ws], // workspace exists
				[], // isWorkspaceOwner → no owner row (caller is member, not owner)
			]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { onboarding_enabled: true }),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('FORBIDDEN')
		})

		it('returns 404 when workspace does not exist', async () => {
			const id = '00000000-0000-0000-0000-000000000099'
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = []

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${id}`, { onboarding_enabled: true }),
			)

			expect(res.status).toBe(404)
		})

		// `byollm_allowed` is the entitlement that bypasses the plan cap, the
		// paid-plan mutex and credit debiting. Every self-signed-up user owns
		// their own workspace, so owner rights must NOT be enough to set it.
		describe('byollm_allowed is ops-gated, not owner-gated', () => {
			const OPS_ACTOR = '11111111-1111-4111-8111-111111111111'
			const ORIGINAL_ENV = process.env.MASKIN_ENTERPRISE_ACTOR_IDS

			// `delete`, not `= undefined`: assigning undefined to process.env
			// stores the STRING "undefined", which would leave the allowlist
			// non-empty and let the "no ops actor" cases pass for the wrong reason.
			function setOpsAllowlist(value: string | undefined) {
				if (value === undefined) {
					// biome-ignore lint/performance/noDelete: required for correct env semantics
					delete process.env.MASKIN_ENTERPRISE_ACTOR_IDS
				} else {
					process.env.MASKIN_ENTERPRISE_ACTOR_IDS = value
				}
			}

			afterEach(() => setOpsAllowlist(ORIGINAL_ENV))

			it('returns 403 and writes nothing when a workspace owner self-grants it', async () => {
				setOpsAllowlist(undefined)
				const ws = buildWorkspace()
				const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
				mockResults.selectQueue = [
					[ws], // workspace exists
					[{ actorId: 'test-actor-id' }], // isWorkspaceOwner → caller IS the owner
				]

				const res = await app.request(
					jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: true }),
				)

				expect(res.status).toBe(403)
				const body = await res.json()
				expect(body.error.code).toBe('FORBIDDEN')
				expect(calls.updates).toHaveLength(0)
			})

			it('returns 403 when an owner smuggles it alongside onboarding_enabled', async () => {
				setOpsAllowlist(undefined)
				const ws = buildWorkspace()
				const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
				mockResults.selectQueue = [[ws], [{ actorId: 'test-actor-id' }]]

				const res = await app.request(
					jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, {
						onboarding_enabled: true,
						byollm_allowed: true,
					}),
				)

				expect(res.status).toBe(403)
				// The permitted half of the body must not land either.
				expect(calls.updates).toHaveLength(0)
			})

			it('returns 403 when byollm_allowed is set to false by a non-ops owner', async () => {
				setOpsAllowlist(undefined)
				const ws = buildWorkspace()
				const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
				mockResults.selectQueue = [[ws], [{ actorId: 'test-actor-id' }]]

				const res = await app.request(
					jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: false }),
				)

				expect(res.status).toBe(403)
			})

			it('allows an ops actor on the allowlist to grant it', async () => {
				setOpsAllowlist(OPS_ACTOR)
				const ws = buildWorkspace()
				const updated = { ...ws, byollmAllowed: true }
				const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces', OPS_ACTOR)
				mockResults.selectQueue = [
					[ws], // workspace exists
					[{ actorId: OPS_ACTOR }], // ops actor is also the owner here
				]
				mockResults.update = [updated]

				const res = await app.request(
					jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: true }),
				)

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body.byollmAllowed).toBe(true)
			})

			it('still lets a plain owner flip onboarding_enabled', async () => {
				setOpsAllowlist(undefined)
				const ws = buildWorkspace()
				const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
				mockResults.selectQueue = [[ws], [{ actorId: 'test-actor-id' }]]
				mockResults.update = [{ ...ws, onboardingEnabled: true }]

				const res = await app.request(
					jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { onboarding_enabled: true }),
				)

				expect(res.status).toBe(200)
			})
		})
	})

	describe('POST /api/workspaces/:id/members', () => {
		it('adds a member and returns 201 when caller is a member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember(callerId, wsId)
				[{ type: 'human' }], // target actor type lookup
				[{ id: wsId, settings: {} }], // workspace row locked FOR UPDATE (trial plan)
				[{ n: 0 }], // countHumanMembers — 0 < trial cap 1
			]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${wsId}/members`, {
					actor_id: actorId,
					role: 'member',
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.added).toBe(true)
		})

		it('returns 403 when caller is not a member of the workspace', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			// isWorkspaceMember → no rows
			mockResults.select = []

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${wsId}/members`, {
					actor_id: actorId,
					role: 'member',
				}),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('FORBIDDEN')
		})
	})

	describe('GET /api/workspaces/:id/members', () => {
		it('returns 200 with list of members', async () => {
			const wsId = randomUUID()
			const member = {
				actorId: randomUUID(),
				role: 'owner',
				joinedAt: new Date(),
				name: 'Alice',
				type: 'human',
			}
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [member]

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/members`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].role).toBe('owner')
		})
	})

	describe('PATCH /api/workspaces/:id/members/:actorId', () => {
		it("changes a member's role and returns 200", async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember(caller)
				[{ role: 'member' }], // existing member row lookup
			]
			mockResults.update = [{ actorId, role: 'admin', joinedAt: new Date() }]
			// After update, the route re-fetches the actor for name/type.
			// selectQueue is exhausted, so the static `select` supplies the actor row.
			mockResults.select = [{ name: 'Alice', type: 'human' }]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.role).toBe('admin')
			expect(calls.updates[0]).toEqual({ role: 'admin' })
		})

		it('returns 403 when caller is not a member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = []

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when the target member does not exist', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[], // existing member lookup — no row
			]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when demoting the only owner', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[{ role: 'owner' }], // existing member is the owner
				[{ actorId }], // owner count = 1 → last owner guard trips
			]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(calls.updates).toHaveLength(0)
		})

		it('returns 400 when caller targets their own actorId', async () => {
			const wsId = randomUUID()
			const selfId = randomUUID()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces', selfId)
			mockResults.select = [{ actorId: selfId }] // isWorkspaceMember passes

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${selfId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(calls.updates).toHaveLength(0)
		})

		it('returns 400 when role is not a valid enum value', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app } = createTestApp(workspacesRoutes, '/api/workspaces')

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'superuser' }),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('DELETE /api/workspaces/:id/members/:actorId', () => {
		it('removes a member and returns 200', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[{ role: 'member' }], // existing member row
			]
			mockResults.delete = [{ actorId }]
			mockResults.insert = [{}]

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${wsId}/members/${actorId}`, {
					method: 'DELETE',
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.removed).toBe(true)
		})

		it('returns 403 when caller is not a member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = []

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${wsId}/members/${actorId}`, {
					method: 'DELETE',
				}),
			)

			expect(res.status).toBe(403)
		})

		it('returns 400 when caller targets their own actorId', async () => {
			const wsId = randomUUID()
			const selfId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces', selfId)
			mockResults.select = [{ actorId: selfId }] // isWorkspaceMember passes

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${wsId}/members/${selfId}`, {
					method: 'DELETE',
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
		})

		it('returns 400 when removing the only owner', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[{ role: 'owner' }], // existing member is the owner
				[{ actorId }], // owner count = 1
			]

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${wsId}/members/${actorId}`, {
					method: 'DELETE',
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
		})
	})
})
