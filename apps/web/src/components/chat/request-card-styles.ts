/**
 * The one look every request card in chat shares (computer help, keychain, tool server,
 * integration access/connect): a soft rounded card, a 15px bold title, 13px body and pill
 * buttons that are 44px tall on touch widths. Classes only, no behaviour. The pieces that
 * are components (header, field row, folded answer) are in `request-card-parts.tsx`.
 */
export const REQUEST_CARD =
	'mt-2 flex w-full min-w-0 flex-col gap-3 rounded-xl bg-card px-[18px] py-4 shadow-[0_0_0_1px_var(--border)]'
export const REQUEST_CARD_TITLE = 'text-[15px] font-bold'
export const REQUEST_CARD_BODY = 'mt-0.5 break-words text-[13px] text-muted-foreground'
export const REQUEST_CARD_BUTTON =
	'rounded-full font-semibold max-md:h-11 max-md:w-full max-md:px-5'
/** "Not now": a quiet text button beside the black primary one, so the choice is clear. */
export const REQUEST_CARD_QUIET_BUTTON = `${REQUEST_CARD_BUTTON} text-muted-foreground`

/** The card's answer buttons, stacked: the black primary full width, "Not now" quiet beneath. */
export const REQUEST_CARD_ACTIONS = 'flex flex-col items-stretch gap-1'
export const REQUEST_CARD_PRIMARY =
	'h-[38px] w-full rounded-full text-[13.5px] font-bold max-md:h-11'
export const REQUEST_CARD_DECLINE =
	'h-8 w-full text-[13px] font-semibold text-muted-foreground hover:bg-transparent hover:text-foreground max-md:h-11'
