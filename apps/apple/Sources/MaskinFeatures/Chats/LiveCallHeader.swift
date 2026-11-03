import MaskinCore
import MaskinDesign
import SwiftUI

/// What the thread's navigation bar shows while a call runs in it: the call's live capsule (green
/// dot and clock) and the red button that ends it.
struct LiveCallHeaderControls: View {
	let session: LiveMeetingSession
	let onEnd: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s3) {
				Circle().fill(MaskinColor.sig).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				CallClock(session: session, mono: true)
			}
			.padding(.horizontal, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(MaskinColor.sigTint, in: Capsule())
			.accessibilityElement(children: .combine)
			.accessibilityLabel("Live call")
			Button {
				MaskinHaptics.play(.medium)
				onEnd()
			} label: {
				Image(systemName: "phone.down.fill")
					.maskinSymbol(MaskinFontSize.t16, weight: .medium)
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.background(MaskinColor.danger, in: Circle())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.accessibilityLabel("End call")
		}
	}
}
