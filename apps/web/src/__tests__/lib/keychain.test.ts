import { clearAuth, getApiKey, isAuthenticated, restoreSession, setApiKey } from '@/lib/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeMock = ReturnType<typeof vi.fn>

type WindowWithTauri = Window & { __TAURI_INTERNALS__?: { invoke: InvokeMock } }

const invokeMock: InvokeMock = vi.fn()

function setTauriShell() {
	// Simulate the Tauri shell injecting its IPC bridge.
	;(window as unknown as WindowWithTauri).__TAURI_INTERNALS__ = { invoke: invokeMock }
}

function clearTauriShell() {
	;(window as unknown as WindowWithTauri).__TAURI_INTERNALS__ = undefined
}

beforeEach(() => {
	invokeMock.mockReset()
	setTauriShell()
	localStorage.clear()
})

afterEach(() => {
	clearAuth()
	clearTauriShell()
})

describe('keychain sign-in', () => {
	it('writes the key to the Keychain and never to web storage', () => {
		setApiKey('ank_test123')
		expect(invokeMock).toHaveBeenCalledWith('set_api_key', { key: 'ank_test123' })
		expect(localStorage.getItem('maskin-api-key')).toBeNull()
		expect(getApiKey()).toBe('ank_test123')
	})
})

describe('keychain relaunch restore', () => {
	it('restores the session from the Keychain after full quit + relaunch', async () => {
		invokeMock.mockResolvedValue('ank_persisted')
		await restoreSession()
		expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'get_api_key')).toBe(true)
		expect(getApiKey()).toBe('ank_persisted')
		expect(isAuthenticated()).toBe(true)
	})

	it('falls to the login screen on a fresh install with no stored key', async () => {
		invokeMock.mockResolvedValue(null)
		await restoreSession()
		expect(getApiKey()).toBeNull()
		expect(isAuthenticated()).toBe(false)
	})
})

describe('keychain sign-out', () => {
	it('removes the key from the Keychain', () => {
		invokeMock.mockResolvedValue('ank_test123')
		setApiKey('ank_test123')
		clearAuth()
		expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'delete_api_key')).toBe(true)
		expect(getApiKey()).toBeNull()
		expect(isAuthenticated()).toBe(false)
	})
})
