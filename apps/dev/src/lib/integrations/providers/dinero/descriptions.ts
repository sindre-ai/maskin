/**
 * Dinero's own tool descriptions tell the agent to "book afterwards with BookVoucher". While the
 * owner's booking switch is off BookVoucher is not on the agent's list (./allowed-tools.ts), so
 * that sends it looking for a tool it will never have. This rewrites the sentence to say a person
 * books in Dinero. The upstream text is Danish; only the BookVoucher references are touched, and a
 * description with none is returned as it is. Not applied when the switch is on, because then
 * BookVoucher is on the list and the text is true.
 */
const BOOKED_BY_PERSON = 'Kladden bogføres af en person i Dinero, ikke af dig.'

export function withoutBookVoucherPointer(description: string): string {
	return (
		description
			// CreatePurchaseVoucher: "Bogfør den bagefter med BookVoucher, når brugeren har bedt om det."
			.replace(/Bogfør\s+den\s+bagefter\s+med\s+BookVoucher,[^.]*\./g, BOOKED_BY_PERSON)
			// get_purchase_voucher: "skal bruges til bogføring (BookVoucher), betalinger (...)"
			.replace(/bogføring\s*\(BookVoucher\),\s*/g, '')
			// Any other mention: never name a tool the agent has not got.
			.replace(/\s*\(?\bBookVoucher\b\)?/g, ' (bogføres af en person i Dinero)')
	)
}
