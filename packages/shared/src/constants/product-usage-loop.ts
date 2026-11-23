// Canonical source-item IDs and metadata for the Product Analytics marketplace
// loop (slug kept from its first name, Product Usage). The one actor is the Product Analyst.
// Trigger and skill IDs are not listed as constants: they are derived per actor via `triggerIdsForActor` /
// `skillIdsForActor` in apps/dev/src/lib/marketplace-loops/loop-data.

export const PRODUCT_USAGE_ACTOR_ANALYST = 'beaa6cc3-8c50-424c-a129-4d529dee4e15'

export const PRODUCT_USAGE_LOOP_SLUG = 'product-usage-loop'
export const PRODUCT_USAGE_LOOP_NAME = 'Product Analytics'
// 1.1.0: renamed from Product Usage, adds the daily anomaly check, the Setup section and the Lifecycle tab.
export const PRODUCT_USAGE_LOOP_VERSION = '1.1.0'
export const PRODUCT_USAGE_LOOP_USE_CASE = 'Discovery'
// Earlier names of this flow. An install still carrying one is renamed by the version update.
export const PRODUCT_USAGE_LOOP_FORMER_NAMES: readonly string[] = ['Product Usage']

// The Setup section of the flow description. The agents read it first and never change it; the
// installer fills the empty lines. It starts at the marker the version update looks for.
export const PRODUCT_USAGE_SETUP_MARKER = '**Setup'
export const PRODUCT_USAGE_SETUP_SECTION = [
	'**Setup (edit this section to fit your product and analytics tool; the agents read it first and never change it)**',
	'',
	'- Product and platforms:',
	'- Analytics tool and project:',
	'- Tracking plan (what each event means and which areas exist):',
	'- Real people only (how to leave out internal and test users):',
	'- Healthy feed (default: human events on every day of the last 7 days and no gap over 24 hours):',
	'- Activation (default: sign-up, then the first meaningful action, then a second person invited):',
	'- Critical means (default: a success event in the plan falls by more than half week on week with a count of 10 or more behind it, or a main path stops producing events):',
	'- Notify on critical:',
	'- Owner of tracking fixes (events, dashboards, access):',
	'- Extra view tabs to keep fresh: Results, and Lifecycle (a stage-by-stage snapshot of the lifecycle dashboard, human events only, internal users left out; states the snapshot date).',
	'',
	'If a line here is empty, the agents discover it from the analytics tool, note the guess in one line on this flow, and carry on.',
].join('\n')

const PRODUCT_USAGE_LOOP_SUMMARY =
	'Reads how real people use your product, spots meaningful changes, trends, anomalies and friction, and files insights with a recommended action. Every Monday a Product Analyst reads the last seven days of real human usage from the product analytics tool you connect, checks the data feed is healthy first, and files one sourced insight per finding with the count behind every number. A daily check compares yesterday with the usual level. A critical finding notifies the person you name in Setup. A quiet week stays silent. Results and Lifecycle tabs keep the few findings that deserve a person and a stage-by-stage snapshot. Needs a product analytics tool such as PostHog, Mixpanel or Amplitude, connected after install. With none connected it says so once and stops.'

export const PRODUCT_USAGE_LOOP_DESCRIPTION = `${PRODUCT_USAGE_LOOP_SUMMARY}\n\n${PRODUCT_USAGE_SETUP_SECTION}`
