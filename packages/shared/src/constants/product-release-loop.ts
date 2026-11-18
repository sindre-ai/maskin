// Canonical source-item IDs and metadata for the Product release marketplace
// loop. The actors are the Release Manager and the optional Store Release
// Manager. Trigger and skill IDs are not listed as constants: they are derived
// per actor via `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data.

export const PRODUCT_RELEASE_ACTOR_MANAGER = 'd0c68509-2eee-42a6-8a21-31003b7cba76'
export const PRODUCT_RELEASE_ACTOR_STORE = '82a9887c-b172-40d6-ac88-3a70424e0cb3'

export const PRODUCT_RELEASE_LOOP_SLUG = 'product-release-loop'
export const PRODUCT_RELEASE_LOOP_NAME = 'Product release'
export const PRODUCT_RELEASE_LOOP_VERSION = '1.0.0'
export const PRODUCT_RELEASE_LOOP_USE_CASE = 'Delivery'
export const PRODUCT_RELEASE_LOOP_DESCRIPTION =
	'Takes merged work to customers. Twice a week a release manager reads what merged on your code host, bundles the user-facing changes into one versioned release, picks a version and a tier and writes the notes the tier needs. A release is done once it is live and its announcements are read back. If you ship a mobile app, an optional store step follows each version through review and tells the release manager when it is live. Connect your code host after install. The store step switches itself off until a store is connected.'
