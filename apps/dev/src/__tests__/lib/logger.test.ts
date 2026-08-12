import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sentry/node', () => ({
	captureMessage: vi.fn(),
	addBreadcrumb: vi.fn(),
}))

import * as Sentry from '@sentry/node'
import { logger } from '../../lib/logger'

describe('logger', () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.mocked(Sentry.captureMessage).mockReset()
		vi.mocked(Sentry.addBreadcrumb).mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function parseOutput(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
		const raw = spy.mock.calls[0]?.[0] as string
		return JSON.parse(raw)
	}

	describe('info', () => {
		it('outputs JSON to console.log with correct level and msg', () => {
			logger.info('server started')
			expect(logSpy).toHaveBeenCalledOnce()

			const entry = parseOutput(logSpy)
			expect(entry.level).toBe('info')
			expect(entry.msg).toBe('server started')
		})

		it('includes a valid ISO timestamp', () => {
			logger.info('test')
			const entry = parseOutput(logSpy)
			expect(new Date(entry.timestamp as string).toISOString()).toBe(entry.timestamp)
		})

		it('includes extra context fields', () => {
			logger.info('request', { method: 'GET', path: '/api/health' })
			const entry = parseOutput(logSpy)
			expect(entry.method).toBe('GET')
			expect(entry.path).toBe('/api/health')
		})
	})

	describe('debug', () => {
		it('outputs to console.log with level debug', () => {
			logger.debug('trace info')
			expect(logSpy).toHaveBeenCalledOnce()

			const entry = parseOutput(logSpy)
			expect(entry.level).toBe('debug')
			expect(entry.msg).toBe('trace info')
		})
	})

	describe('warn', () => {
		it('outputs to console.log with level warn', () => {
			logger.warn('deprecation notice')
			expect(logSpy).toHaveBeenCalledOnce()

			const entry = parseOutput(logSpy)
			expect(entry.level).toBe('warn')
			expect(entry.msg).toBe('deprecation notice')
		})

		it('adds a Sentry breadcrumb', () => {
			logger.warn('deprecation notice', { feature: 'x' })
			expect(Sentry.addBreadcrumb).toHaveBeenCalledOnce()
			expect(Sentry.addBreadcrumb).toHaveBeenCalledWith({
				category: 'log',
				level: 'warning',
				message: 'deprecation notice',
				data: { feature: 'x' },
			})
		})

		it('does not throw and still logs when Sentry.addBreadcrumb itself throws', () => {
			vi.mocked(Sentry.addBreadcrumb).mockImplementation(() => {
				throw new Error('sentry down')
			})
			expect(() => logger.warn('deprecation notice')).not.toThrow()
			expect(logSpy).toHaveBeenCalledOnce()
		})
	})

	describe('error', () => {
		it('outputs to console.error (not console.log)', () => {
			logger.error('something broke')
			expect(errorSpy).toHaveBeenCalledOnce()
			expect(logSpy).not.toHaveBeenCalled()

			const entry = parseOutput(errorSpy)
			expect(entry.level).toBe('error')
			expect(entry.msg).toBe('something broke')
		})

		it('includes context fields', () => {
			logger.error('db failed', { code: 'ECONNREFUSED', host: 'localhost' })
			const entry = parseOutput(errorSpy)
			expect(entry.code).toBe('ECONNREFUSED')
			expect(entry.host).toBe('localhost')
		})

		it('reports to Sentry.captureMessage by default', () => {
			logger.error('something broke', { code: 'X' })
			expect(Sentry.captureMessage).toHaveBeenCalledOnce()
			expect(Sentry.captureMessage).toHaveBeenCalledWith('something broke', {
				level: 'error',
				extra: { code: 'X' },
			})
		})

		it('does not report to Sentry when skipSentry is set, to avoid double-reporting an error already captured directly', () => {
			logger.error('something broke', { code: 'X' }, { skipSentry: true })
			expect(Sentry.captureMessage).not.toHaveBeenCalled()
		})

		it('does not throw and still logs when Sentry.captureMessage itself throws', () => {
			vi.mocked(Sentry.captureMessage).mockImplementation(() => {
				throw new Error('sentry down')
			})
			expect(() => logger.error('something broke')).not.toThrow()
			// First call is the normal JSON error line; a second console.error call
			// reports the Sentry failure itself so it isn't silently swallowed.
			const entry = parseOutput(errorSpy)
			expect(entry.msg).toBe('something broke')
		})
	})
})
