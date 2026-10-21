import { z } from '@hono/zod-openapi'
import { NATIVE_OAUTH_RETURN_URLS } from '@maskin/shared'

/**
 * Optional JSON body of the connect routes, declared for the generated OpenAPI
 * spec. `native_return_url` is deliberately typed as a loose nullable string:
 * the handlers keep owning the exact-match allowlist check (and its 400 body),
 * so declaring the field documents the contract without changing it. The allowed
 * values are listed in the description rather than as an `enum`, which could not
 * also admit the `null` the handlers accept.
 */
export const nativeConnectBodySchema = z
	.object({
		native_return_url: z
			.string()
			.nullable()
			.optional()
			.openapi({
				description: `Where a native app is sent after the provider flow. Must exactly equal one of: ${NATIVE_OAUTH_RETURN_URLS.join(', ')}. Any other value is refused with 400.`,
			}),
	})
	.passthrough()

/**
 * Add the optional body to a connect route's OpenAPI description AFTER the route
 * has been registered with `app.openapi()`.
 *
 * It cannot live in the route definition: `@hono/zod-openapi` turns a declared
 * body into a request validator, and Hono's JSON validator answers an empty or
 * malformed body with its own 400. These handlers have always tolerated both
 * (`c.req.json().catch(() => ({}))`, and clients post `Content-Type: application/json`
 * with no body), so validating would change the runtime contract. Validators are
 * built when `app.openapi()` reads the route; the spec is built later from the same
 * route object, so setting the body in between documents it without enforcing it.
 */
export function declareNativeConnectBody(route: { request?: object }): void {
	// Mutate in place: the registry holds a copy of the route but shares `request`.
	Object.assign(route.request ?? {}, {
		body: {
			required: false,
			content: { 'application/json': { schema: nativeConnectBodySchema } },
		},
	})
}
