import { describe, expect, it, vi } from 'vitest'
import { type DesktopServer, WorkspaceDesktopService } from '../../services/workspace-desktop'

const WS = '11111111-1111-4111-8111-111111111111'
const AGENT = '44444444-4444-4444-8444-444444444444'
const OTHER_AGENT = '55555555-5555-4555-8555-555555555555'

const server = (id: string, status: DesktopServer['status'] = 'active'): DesktopServer => ({
	id,
	url: `https://${id}.example`,
	secret: `secret-${id}`,
	status,
})

function res(status: number, body: unknown = {}): Response {
	return new Response(JSON.stringify(body), { status })
}

describe('WorkspaceDesktopService', () => {
	it('locate returns the server that already hosts the desktop', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) =>
			String(url).includes('b.example') ? res(200, { password: 'pw' }) : res(404),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})

		const found = await svc.locate(WS, AGENT)

		expect(found?.server.id).toBe('b')
		expect(found?.password).toBe('pw')
	})

	it('locate sends the bearer secret and skips disabled servers', async () => {
		const fetchImpl = vi.fn(async () => res(404))
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('x', 'disabled')],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		await svc.locate(WS, AGENT)

		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(`https://a.example/desktops/${WS}/${AGENT}`)
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-a')
	})

	it('locate tolerates a server that errors', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes('a.example')) throw new Error('down')
			return res(200, { password: 'pw' })
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})
		expect((await svc.locate(WS, AGENT))?.server.id).toBe('b')
	})

	it('ensure reuses an existing desktop without provisioning', async () => {
		const fetchImpl = vi.fn(async () => res(200, { password: 'pw' }))
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		const got = await svc.ensure(WS, AGENT)

		expect(got?.created).toBeUndefined()
		for (const call of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
			expect(call[1].method).toBe('GET')
		}
	})

	it('locate reports a suspended desktop as suspended', async () => {
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: (async () =>
				res(200, { password: 'pw', status: 'suspended' })) as unknown as typeof fetch,
		})
		expect((await svc.locate(WS, AGENT))?.status).toBe('suspended')
	})

	it('ensure wakes a suspended desktop on the server that holds it, without provisioning anew', async () => {
		const calls: string[] = []
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method} ${String(url)}`)
			if (init?.method === 'PUT') return res(200, { password: 'pw', status: 'running' })
			return String(url).includes('b.example')
				? res(200, { password: 'pw', status: 'suspended' })
				: res(404)
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			// `a` is the first active server, but `b` is the one holding the sleeping desktop.
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})

		const got = await svc.ensure(WS, AGENT)

		expect(got?.server.id).toBe('b')
		expect(got?.status).toBe('running')
		expect(got?.created).toBeUndefined()
		expect(calls).toContain(`PUT https://b.example/desktops/${WS}/${AGENT}`)
		expect(calls.some((c) => c.startsWith('PUT https://a.example'))).toBe(false)
	})

	it('keeps two agents in one workspace apart', async () => {
		const urls: string[] = []
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			urls.push(`${init?.method} ${String(url)}`)
			return init?.method === 'PUT' ? res(200, { password: 'pw' }) : res(404)
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({ listServers: async () => [server('a')], fetchImpl })

		await svc.ensure(WS, AGENT)
		await svc.ensure(WS, OTHER_AGENT)

		expect(urls).toContain(`PUT https://a.example/desktops/${WS}/${AGENT}`)
		expect(urls).toContain(`PUT https://a.example/desktops/${WS}/${OTHER_AGENT}`)
	})

	it('list gathers every agent computer across servers, with its status', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) =>
			String(url).includes('a.example')
				? res(200, { desktops: [{ agent_id: AGENT, status: 'running' }] })
				: res(200, { desktops: [{ agent_id: OTHER_AGENT, status: 'suspended' }] }),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})

		const listed = await svc.list(WS)

		expect(listed).toEqual([
			{ agentId: AGENT, status: 'running' },
			{ agentId: OTHER_AGENT, status: 'suspended' },
		])
		const [url] = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0] ?? []
		expect(url).toBe(`https://a.example/desktops/${WS}`)
	})

	it('list tolerates a server that is down', async () => {
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl: (async (url: string | URL | Request) => {
				if (String(url).includes('a.example')) throw new Error('down')
				return res(200, { desktops: [{ agent_id: AGENT, status: 'running' }] })
			}) as unknown as typeof fetch,
		})
		expect(await svc.list(WS)).toEqual([{ agentId: AGENT, status: 'running' }])
	})

	it('ensure provisions on the first active server when none hosts it', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'PUT' ? res(200, { password: 'new' }) : res(404),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('d', 'draining'), server('a'), server('b')],
			fetchImpl,
		})

		const got = await svc.ensure(WS, AGENT)

		expect(got).toMatchObject({ password: 'new', created: true })
		expect(got?.server.id).toBe('a')
	})

	it('ensure returns null with no active server or when provisioning fails', async () => {
		const none = new WorkspaceDesktopService({
			listServers: async () => [server('d', 'draining')],
			fetchImpl: (async () => res(404)) as unknown as typeof fetch,
		})
		expect(await none.ensure(WS, AGENT)).toBeNull()

		const failing = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) =>
				init?.method === 'PUT' ? res(502) : res(404)) as unknown as typeof fetch,
		})
		expect(await failing.ensure(WS, AGENT)).toBeNull()
	})

	it('ensure refuses to provision when a server could not answer the lookup', async () => {
		const calls: string[] = []
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method} ${String(url)}`)
			if (String(url).includes('a.example')) return res(503)
			return init?.method === 'PUT' ? res(200, { password: 'new' }) : res(404)
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})

		await expect(svc.ensure(WS, AGENT)).rejects.toThrow(/could not tell/)
		expect(calls.some((c) => c.startsWith('PUT'))).toBe(false)
	})

	it('ensure still uses the desktop a reachable server reports when another server is down', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) =>
			String(url).includes('a.example') ? res(503) : res(200, { password: 'pw' }),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})
		expect((await svc.ensure(WS, AGENT))?.server.id).toBe('b')
	})

	it('remove refuses to say "nothing to remove" when a server could not answer', async () => {
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl: (async (url: string | URL | Request) =>
				String(url).includes('a.example') ? res(500) : res(404)) as unknown as typeof fetch,
		})
		await expect(svc.remove(WS, AGENT)).rejects.toThrow(/could not tell/)
	})

	it('remove deletes on the hosting server and reports whether one existed', async () => {
		const calls: string[] = []
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method} ${String(url)}`)
			if (init?.method === 'GET') return res(200, { password: 'pw' })
			return res(200, { removed: true })
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({ listServers: async () => [server('a')], fetchImpl })

		expect(await svc.remove(WS, AGENT)).toBe(true)
		expect(calls).toContain(`DELETE https://a.example/desktops/${WS}/${AGENT}`)

		const empty = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: (async () => res(404)) as unknown as typeof fetch,
		})
		expect(await empty.remove(WS, AGENT)).toBe(false)
	})
})

describe('WorkspaceDesktopService.control', () => {
	it('provisions the desktop first, then forwards the action with the server secret', async () => {
		const calls: Array<{ method: string; url: string; auth?: string; body?: string }> = []
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>
			calls.push({
				method: String(init?.method),
				url: String(url),
				auth: headers.Authorization,
				body: init?.body as string | undefined,
			})
			if (init?.method === 'GET') return res(404) // not located yet
			if (init?.method === 'PUT') return res(200, { password: 'pw' })
			return res(200, { ok: true })
		}) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({ listServers: async () => [server('a')], fetchImpl })

		const result = await svc.control(WS, AGENT, 'input', { action: 'move', x: 1, y: 2 })

		expect(result).toEqual({ status: 200, body: { ok: true } })
		expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'POST'])
		const post = calls[2]
		expect(post?.url).toBe(`https://a.example/desktops/${WS}/${AGENT}/input`)
		expect(post?.auth).toBe('Bearer secret-a')
		expect(JSON.parse(post?.body ?? '{}')).toEqual({ action: 'move', x: 1, y: 2 })
	})

	it('returns null when no server can host a desktop', async () => {
		const svc = new WorkspaceDesktopService({
			listServers: async () => [],
			fetchImpl: vi.fn() as unknown as typeof fetch,
		})

		expect(await svc.control(WS, AGENT, 'screenshot', {})).toBeNull()
	})

	it("passes through the desktop's own error status instead of masking it", async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'POST'
				? res(400, { error: 'invalid_request' })
				: res(200, { password: 'pw' }),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({ listServers: async () => [server('a')], fetchImpl })

		expect(await svc.control(WS, AGENT, 'exec', { command: 'x' })).toEqual({
			status: 400,
			body: { error: 'invalid_request' },
		})
	})

	it('provisions a new desktop on the preferred server when it is active', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'PUT' ? res(200, { password: 'pw' }) : res(404),
		)
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		const found = await svc.ensure(WS, AGENT, { preferServerId: 'b' })

		expect(found?.server.id).toBe('b')
	})

	it('ignores a preferred server that is draining and falls back to the first active one', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'PUT' ? res(200, { password: 'pw' }) : res(404),
		)
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b', 'draining')],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})

		expect((await svc.ensure(WS, AGENT, { preferServerId: 'b' }))?.server.id).toBe('a')
	})

	it('does not move an existing desktop to the preferred server', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) =>
			String(url).includes('a.example') ? res(200, { password: 'pw' }) : res(404),
		) as unknown as typeof fetch
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a'), server('b')],
			fetchImpl,
		})

		expect((await svc.ensure(WS, AGENT, { preferServerId: 'b' }))?.server.id).toBe('a')
	})

	it('ports forwards expose, list and close to the hosting server with its secret', async () => {
		const fetchImpl = vi.fn(async () => res(200, { ok: true }))
		const svc = new WorkspaceDesktopService({
			listServers: async () => [server('a')],
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const a = server('a')

		await svc.ports(a, WS, AGENT, { type: 'expose', sessionId: 'sess-1', guestPort: 5173 })
		await svc.ports(a, WS, AGENT, { type: 'list' })
		await svc.ports(a, WS, AGENT, { type: 'close', relayPort: 20003 })

		const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
		const base = `https://a.example/desktops/${WS}/${AGENT}/ports`
		expect(calls[0]?.[0]).toBe(base)
		expect(calls[0]?.[1].method).toBe('POST')
		expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({
			session_id: 'sess-1',
			guest_port: 5173,
		})
		expect(calls[1]?.[0]).toBe(base)
		expect(calls[2]?.[0]).toBe(`${base}/20003`)
		expect(calls[2]?.[1].method).toBe('DELETE')
		for (const [, init] of calls) {
			expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-a')
		}
	})
})
