// Canonical source-item IDs and metadata for the Customer Voice Flow marketplace
// loop. The bundle is a single agent, the Customer Voice Analyst. Trigger, skill and
// view IDs are not listed as constants: triggers and skills are derived per actor via
// `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data, and the view comes from
// data/customer-voice-views.json.

export const CUSTOMER_VOICE_ACTOR_ANALYST = 'c7e4a1d2-5b3f-4a86-9d10-2f8b6e4c7a01'

export const CUSTOMER_VOICE_LOOP_SLUG = 'customer-voice-loop'
export const CUSTOMER_VOICE_LOOP_NAME = 'Customer Voice Flow'
export const CUSTOMER_VOICE_LOOP_VERSION = '1.0.0'
export const CUSTOMER_VOICE_LOOP_USE_CASE = 'Discovery'
export const CUSTOMER_VOICE_LOOP_DESCRIPTION =
	'Reads what customers and VIPs write to you, by email and in customer chat channels, and makes sure none of it is lost. Every weekday an analyst checks the sources you connect (a shared support inbox, customer chat channels, a mailbox), files each distinct request, complaint, question or piece of praise once as an insight that quotes the customer and links the source, and never replies for anyone. An owner heartbeat keeps the sweep on pace and refreshes a Results page each week. That page brings forward the few things that deserve a person, with the evidence and the decision, and says plainly when nothing does. Every source is optional and the flow works with whichever ones you connect. Works well beside a Product Discovery Flow, which turns the insights into opportunities, but does not need one.'
