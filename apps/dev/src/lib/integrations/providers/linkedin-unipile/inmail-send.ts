import { logger } from '../../../logger'
import { LinkedInActionRefusal } from './action-log'
import { LinkedInIntegrationError, isLinkedInIntegrationError } from './errors'
import { INMAIL_CREDIT_FLOOR, inmailFloorReached } from './inmail'
import {
	type LinkedInOperationContext,
	type LinkedInSendExtras,
	getLinkedInProfile,
	readLinkedInInmailCredits,
	sendLinkedInMessage,
} from './operations'

/**
 * The InMail-only steps of `send_inmail`, run by the approved-send path (send-object.ts) once a
 * person's approval of the exact draft is confirmed. Spec: bet aff468ba tech spec §2.7.
 *
 * Nothing here sends until every check has passed, so a refusal costs no credit:
 *   1. the recipient is not a 1st-degree connection (a plain message is free, so an InMail to a
 *      connection would only burn a credit),
 *   2. classic credits are present and above the floor we keep back.
 * Both refuse as `refused_rule` in the action log. The daily cap of 5 is checked before this
 * runs, by the action-log wrapper.
 */

const FIRST_DEGREE = 'FIRST_DEGREE'

function refuse(code: 'INVALID_INPUT' | 'LINKEDIN_INMAIL_UNAVAILABLE', message: string): never {
	throw new LinkedInActionRefusal('refused_rule', code, message)
}

/**
 * Refuses unless this InMail may go, and returns the classic credits held right before it.
 * A failed profile or credits call propagates: with the state unknown, nothing is sent.
 */
export async function assertInmailSendable(
	ctx: LinkedInOperationContext,
	recipientProviderId: string,
): Promise<number> {
	const profile = await getLinkedInProfile(ctx, { identifier: recipientProviderId })
	if (profile.network_distance === FIRST_DEGREE) {
		refuse(
			'INVALID_INPUT',
			'This person is already a 1st-degree connection, so an InMail would spend a credit for nothing: already connected, use send_message. Nothing was sent.',
		)
	}
	if (!profile.network_distance) {
		// A connection must never be sent an InMail, so a profile that does not say is a refusal.
		refuse(
			'INVALID_INPUT',
			'LinkedIn did not say how this person is connected to the account, so the InMail was not sent. Nothing was sent.',
		)
	}

	const credits = await readLinkedInInmailCredits(ctx)
	if (credits.classic === null || inmailFloorReached(credits)) {
		refuse(
			'LINKEDIN_INMAIL_UNAVAILABLE',
			credits.classic === null
				? 'This LinkedIn account has no classic InMail credits. Stop drafting InMails for it and use another channel. Nothing was sent.'
				: `This LinkedIn account has ${credits.classic} classic InMail credits; we always keep ${INMAIL_CREDIT_FLOOR} back, so none can be spent. Stop drafting InMails for it and use another channel. Nothing was sent.`,
		)
	}
	return credits.classic
}

/**
 * Starts the chat as an InMail. Unipile's insufficient-credits reply has not been captured yet,
 * so a 4xx on the start maps to LINKEDIN_INMAIL_UNAVAILABLE only when a fresh credits read
 * shows the floor reached; any other failure keeps its own code.
 */
export async function startInmailChat(
	ctx: LinkedInOperationContext,
	input: { recipient_urn: string; body: string; idempotency_key: string },
	extras: Pick<LinkedInSendExtras, 'attachments'>,
) {
	try {
		return await sendLinkedInMessage(ctx, input, { ...extras, inmail: true })
	} catch (err) {
		if (isLinkedInIntegrationError(err) && err.httpStatus >= 400 && err.httpStatus < 500) {
			const fresh = await readLinkedInInmailCredits(ctx).catch(() => null)
			if (fresh && inmailFloorReached(fresh)) {
				throw new LinkedInIntegrationError(
					'LINKEDIN_INMAIL_UNAVAILABLE',
					'LinkedIn refused the InMail and this account is out of classic InMail credits (we keep 2 back). Stop drafting InMails for it and use another channel.',
					{ cause: err },
				)
			}
		}
		throw err
	}
}

/**
 * The credits right after the send, for the log. The InMail is already gone, so a failed read
 * is a null, never an error the caller would retry.
 */
export async function readCreditsAfter(ctx: LinkedInOperationContext): Promise<number | null> {
	try {
		return (await readLinkedInInmailCredits(ctx)).classic
	} catch (err) {
		logger.warn('linkedin-unipile send_inmail: credits read after the send failed', {
			code: isLinkedInIntegrationError(err) ? err.code : 'unknown',
		})
		return null
	}
}
