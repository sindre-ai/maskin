// Canonical source-item IDs and metadata for the Product Delivery marketplace flow. The actors are
// the Delivery Lead, Developer, Reviewer and Coordinator. Trigger and skill IDs are not listed as
// constants: they are derived per actor via `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data.

export const PRODUCT_DELIVERY_ACTOR_LEAD = '7a1f3c52-5b0e-4d6a-9c1e-2f8b6a0d4e11'
export const PRODUCT_DELIVERY_ACTOR_DEVELOPER = '3c9e8d47-1a2b-4f65-8e03-b7d5c4a91f22'
export const PRODUCT_DELIVERY_ACTOR_REVIEWER = '9b4d2e61-7c3a-4a18-b5f0-6e1d8c3a7f33'
export const PRODUCT_DELIVERY_ACTOR_COORDINATOR = 'e5a7c910-2d4b-4b8e-a6c3-0f9e1b5d2a44'

export const PRODUCT_DELIVERY_LOOP_SLUG = 'product-delivery-loop'
export const PRODUCT_DELIVERY_LOOP_NAME = 'Product Delivery'
export const PRODUCT_DELIVERY_LOOP_VERSION = '1.0.0'
export const PRODUCT_DELIVERY_LOOP_USE_CASE = 'Delivery'
export const PRODUCT_DELIVERY_LOOP_DESCRIPTION =
	'Takes a bet from define to live. When a bet reaches define, the delivery lead sets the success criteria. Each task is built by a developer, checked by a reviewer who runs the change, and merged once it passes. A coordinator keeps tasks moving and starts the final review when the last task passes. When a bet is live, the delivery lead reads the numbers and gives a won, lost or inconclusive call, and a weekly briefing says what shipped and what is stuck. Connect your code host and your analytics tool after install. Steps that need one switch themselves off until it is connected.'
