import { OpenAPIHono } from '@hono/zod-openapi'

// Hidden endpoint that throws so the app-factory `onError` handler forwards
// the error to Sentry — used to verify the DSN + release wiring end-to-end
// from a running instance. Mounted only when SENTRY_TEST_ENABLED=true, so
// production never exposes an unauthenticated throw endpoint by default.
// The mount decision is made once at app-factory time; toggling the env at
// runtime requires a restart.
const app = new OpenAPIHono()

app.get('/', () => {
	throw new Error('Sentry test exception from apps/dev (/api/sentry-test)')
})

export default app
