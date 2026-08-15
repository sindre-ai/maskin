import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sentry/node', () => ({
	captureMessage: vi.fn(),
	addBreadcrumb: vi.fn(),
}))

import * as Sentry from '@sentry/node'
import { logger } from '../lib/logger'

describe('logger', () => {
	let stdoutSpy: ReturnType<typeof vi.spyOn>
	let stderrSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>
		stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>
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
		it('writes JSON to stdout', () => {
			logger.info('server started')
			expect(stdoutSpy).toHaveBeenCalledOnce()
			const entry = parseOutput(stdoutSpy)
			expect(entry.level).toBe('info')
			expect(entry.msg).toBe('server started')
		})
	})

	describe('warn', () => {
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
			expect(stderrSpy).toHaveBeenCalled()
		})
	})

	describe('error', () => {
		it('writes JSON to stderr (not stdout)', () => {
			logger.error('something broke')
			expect(stderrSpy).toHaveBeenCalledOnce()
			expect(stdoutSpy).not.toHaveBeenCalled()
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
			expect(stderrSpy).toHaveBeenCalled()
		})
	})
})
