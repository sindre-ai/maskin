// Canonical source-item IDs and metadata for the Product Usage marketplace
// loop. The one actor is the Product Analyst. Trigger and skill IDs are not
// listed as constants: they are derived per actor via `triggerIdsForActor` /
// `skillIdsForActor` in apps/dev/src/lib/marketplace-loops/loop-data.

export const PRODUCT_USAGE_ACTOR_ANALYST = 'beaa6cc3-8c50-424c-a129-4d529dee4e15'

export const PRODUCT_USAGE_LOOP_SLUG = 'product-usage-loop'
export const PRODUCT_USAGE_LOOP_NAME = 'Product Usage'
export const PRODUCT_USAGE_LOOP_VERSION = '1.0.0'
export const PRODUCT_USAGE_LOOP_USE_CASE = 'Discovery'
export const PRODUCT_USAGE_LOOP_DESCRIPTION =
	'Reads how people really use your product and files what changed. Every Monday a Product Analyst reads the last seven days of real human usage from the product analytics tool you connect, checks the data feed is healthy first, and files one sourced insight per finding that changed or contradicts what you believe, with the count behind every number. A daily check keeps the weekly read on track, tracks how many reads were done, and keeps a Results tab current with the few findings that deserve a person. A quiet week stays silent. Needs a product analytics tool such as PostHog, Mixpanel or Amplitude. With none connected it says so once and stops.'
