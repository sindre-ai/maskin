import * as Sentry from '@sentry/node'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
	level: LogLevel
	msg: string
	timestamp: string
	[key: string]: unknown
}

interface LogOpts {
	// Set when the caller already reported this error to Sentry directly
	// (e.g. Sentry.captureException with the real Error object, which groups
	// and displays far better than a message-only capture) — skips the
	// automatic captureMessage below so the same failure isn't double-reported.
	skipSentry?: boolean
}

function log(level: LogLevel, msg: string, context?: Record<string, unknown>, opts?: LogOpts) {
	const entry: LogEntry = {
		level,
		msg,
		timestamp: new Date().toISOString(),
		...context,
	}
	const output = JSON.stringify(entry)
	if (level === 'error') {
		console.error(output)
		if (!opts?.skipSentry) Sentry.captureMessage(msg, { level: 'error', extra: context })
	} else {
		console.log(output)
		if (level === 'warn') {
			Sentry.addBreadcrumb({ category: 'log', level: 'warning', message: msg, data: context })
		}
	}
}

export const logger = {
	debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>, opts?: LogOpts) =>
		log('error', msg, ctx, opts),
}
