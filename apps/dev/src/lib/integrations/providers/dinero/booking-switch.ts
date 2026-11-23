/**
 * What the owner reads before switching booking on. The route returns it and refuses the switch
 * unless the caller confirms it was shown (acknowledged: true).
 */
export const DINERO_BOOKING_STATEMENT = [
	'With booking on, the flow books the vouchers it is sure about and registers payments on its own, with no tap per item.',
	'It can also email a booked invoice to your customer and send payment reminders, from Dinero. Those emails reach your customers and cannot be taken back.',
	'Everything it does in Dinero is logged: what, when, the amounts, the account, the VAT code, the counterparty and why.',
	'Anything it doubts stays a draft with a flag. Nothing is filed with SKAT or Erhvervsstyrelsen by the flow.',
	'A booked voucher cannot be deleted in Dinero. It is corrected with a counter-posting, until you approve the books.',
	'You review it all at the end, and nothing leaves Dinero without your final approval.',
	'The Dinero user who signed in must be a super-user in Dinero, or Dinero refuses to book.',
].join(' ')
