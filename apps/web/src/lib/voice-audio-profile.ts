export type NoiseReduction = 'near_field' | 'far_field'

const NEAR_FIELD_LABEL = /headset|headphone|earbud|airpod|bluetooth|earphone|hands-?free/i
const MOBILE_UA = /android|iphone|ipad|ipod|mobile/i

/**
 * Whether the mic sits close to the mouth (near_field) or across a room
 * (far_field). Headsets, earbuds, bluetooth devices and phones/tablets are near;
 * built-in laptop and desktop mics are far. An unknown label on a desktop
 * defaults to far, which is the built-in-mic case.
 */
export function pickNoiseReduction(trackLabel: string, userAgent: string): NoiseReduction {
	if (NEAR_FIELD_LABEL.test(trackLabel)) return 'near_field'
	if (MOBILE_UA.test(userAgent)) return 'near_field'
	return 'far_field'
}
