// Canonical source-item IDs for the Customer Continuous Discovery catalog package.
// These are the IDs of the actors and triggers in the Maskin publishing workspace
// (CCD_SOURCE_WORKSPACE_ID). All three seeding paths — dev-bootstrap, db:seed, and
// the publish script — import from here so a CCD actor/trigger ID is only written
// in one place.

export const CCD_ACTOR_CUSTOMER_FEEDBACK = '0e03b5fb-300a-4c46-97f4-3bbfbd1ba3d6'
export const CCD_ACTOR_INSIGHTS_TRIAGE = '99b416f2-a0c3-4ffb-8299-ff9d0e2be0e8'
export const CCD_ACTOR_PRODUCT_IDEATOR = '11cda8bc-1048-4139-8fa3-fa142dfcb397'
export const CCD_ACTOR_CUSTOMER_CURATOR = 'bc03c9ac-bc2c-401d-89e5-df5ce4714bcb'

export const CCD_PACKAGE_SLUG = 'customer-continuous-discovery'
export const CCD_PACKAGE_NAME = 'Customer Continuous Discovery'
export const CCD_PACKAGE_VERSION = '1.0.0'
export const CCD_PACKAGE_USE_CASE = 'Discovery'
export const CCD_PACKAGE_DESCRIPTION =
	'Turns customer feedback into clustered insights, new bets, and replies back to the customer.'
