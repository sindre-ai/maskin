import {
	SIDEBAR_STORAGE_PREFIX,
	getStoredSidebarOpen,
	isHiddenRouteId,
	migrateLegacySidebarState,
	persistSidebarOpen,
	viewKeyFromRouteId,
} from '@/lib/nav-view-keys'
import { afterEach, describe, expect, it } from 'vitest'

function seed(entries: Record<string, string>) {
	for (const [k, v] of Object.entries(entries)) {
		localStorage.setItem(k, v)
	}
}

describe('isHiddenRouteId', () => {
	it('returns true only for shell-level route ids', () => {
		expect(isHiddenRouteId('__root__')).toBe(true)
		expect(isHiddenRouteId('/_authed')).toBe(true)
		expect(isHiddenRouteId('/_authed/')).toBe(true)
		expect(isHiddenRouteId('/_authed/$workspaceId')).toBe(true)
		expect(isHiddenRouteId('/_authed/$workspaceId/objects/')).toBe(false)
	})
})

describe('viewKeyFromRouteId', () => {
	it('returns null for hidden route ids', () => {
		expect(viewKeyFromRouteId('__root__')).toBeNull()
		expect(viewKeyFromRouteId('/_authed/$workspaceId')).toBeNull()
	})

	it('maps the For You landing to home', () => {
		expect(viewKeyFromRouteId('/_authed/$workspaceId/')).toBe('home')
	})

	it('maps list surfaces to their static segment', () => {
		expect(viewKeyFromRouteId('/_authed/$workspaceId/objects/')).toBe('objects')
		expect(viewKeyFromRouteId('/_authed/$workspaceId/settings/')).toBe('settings')
	})

	it('maps nested static routes to dash-joined keys', () => {
		expect(viewKeyFromRouteId('/_authed/$workspaceId/settings/members')).toBe('settings-members')
	})

	it('maps any param route to a -detail key sharing the list key', () => {
		expect(viewKeyFromRouteId('/_authed/$workspaceId/objects/$objectId')).toBe('objects-detail')
		expect(viewKeyFromRouteId('/_authed/$workspaceId/objects/$objectId/edit')).toBe(
			'objects-edit-detail',
		)
	})
})

describe('sidebar-open storage', () => {
	afterEach(() => localStorage.clear())

	it('defaults to open when nothing is stored', () => {
		expect(getStoredSidebarOpen('objects')).toBe(true)
	})

	it('round-trips persisted values', () => {
		persistSidebarOpen('objects-detail', false)
		expect(localStorage.getItem(`${SIDEBAR_STORAGE_PREFIX}objects-detail`)).toBe('false')
		expect(getStoredSidebarOpen('objects-detail')).toBe(false)
	})

	it('stores each view key independently (per-view persistence)', () => {
		persistSidebarOpen('objects', true)
		persistSidebarOpen('objects-detail', false)
		expect(getStoredSidebarOpen('objects')).toBe(true)
		expect(getStoredSidebarOpen('objects-detail')).toBe(false)
	})
})

describe('migrateLegacySidebarState', () => {
	afterEach(() => localStorage.clear())

	it('seeds the home key from the legacy global flag and removes it', () => {
		seed({ 'maskin-sidebar-open': 'false' })
		migrateLegacySidebarState()
		expect(getStoredSidebarOpen('home')).toBe(false)
		expect(localStorage.getItem('maskin-sidebar-open')).toBeNull()
		expect(localStorage.getItem('ai-native-sidebar-open')).toBeNull()
	})

	it('falls back to the older ai-native key', () => {
		seed({ 'ai-native-sidebar-open': 'true' })
		migrateLegacySidebarState()
		expect(getStoredSidebarOpen('home')).toBe(true)
		expect(localStorage.getItem('ai-native-sidebar-open')).toBeNull()
	})

	it('never overwrites an explicit per-view value', () => {
		seed({ 'maskin-sidebar-open': 'false', [`${SIDEBAR_STORAGE_PREFIX}home`]: 'true' })
		migrateLegacySidebarState()
		expect(getStoredSidebarOpen('home')).toBe(true)
	})

	it('is a no-op when no legacy key exists', () => {
		migrateLegacySidebarState()
		expect(localStorage.getItem(`${SIDEBAR_STORAGE_PREFIX}home`)).toBeNull()
	})
})
