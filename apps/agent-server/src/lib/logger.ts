import * as Sentry from '@sentry/node'

type Level = 'debug' | 'info' | 'warn' | 'error'

interface EmitOpts {
	// Set when the caller already reported this error to Sentry directly
	// (e.g. Sentry.captureException with the real Error object, which groups
	// and displays far better than a message-only capture) — skips the
	// automatic captureMessage below so the same failure isn't double-reported.
	skipSentry?: boolean
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>, opts?: EmitOpts): void {
	const line = ctx
		? JSON.stringify({ level, time: new Date().toISOString(), msg, ...ctx })
		: JSON.stringify({ level, time: new Date().toISOString(), msg })
	if (level === 'error' || level === 'warn') {
		process.stderr.write(`${line}\n`)
	} else {
		process.stdout.write(`${line}\n`)
	}
	// Guarded so a Sentry SDK failure can never turn a logging call into an
	// unhandled throw/rejection for the caller (logger.error is routinely
	// called from fire-and-forget .catch() callbacks).
	if (level === 'error') {
		if (!opts?.skipSentry) {
			try {
				Sentry.captureMessage(msg, { level: 'error', extra: ctx })
			} catch (sentryErr) {
				process.stderr.write(`[sentry] captureMessage failed: ${String(sentryErr)}\n`)
			}
		}
	} else if (level === 'warn') {
		try {
			Sentry.addBreadcrumb({ category: 'log', level: 'warning', message: msg, data: ctx })
		} catch (sentryErr) {
			process.stderr.write(`[sentry] addBreadcrumb failed: ${String(sentryErr)}\n`)
		}
	}
}

export const logger = {
	debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>, opts?: EmitOpts) =>
		emit('error', msg, ctx, opts),
}
