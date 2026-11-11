import MaskinDesign
import SwiftUI

extension View {
	/// A short line over the top of the view for a control that is a stub outside chat (the
	/// composer's "+" and mic). Clears itself after two seconds, or after `seconds`.
	func comingSoonToast(_ message: Binding<String?>, seconds: Double = 2) -> some View {
		overlay(alignment: .top) {
			if let text = message.wrappedValue {
				Text(text)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s8).padding(.vertical, MaskinSpace.s5)
					.background(MaskinSurface.inverse, in: Capsule())
					.padding(.top, MaskinSpace.s9)
					.transition(.opacity)
					.task(id: text) {
						try? await Task.sleep(for: .seconds(seconds))
						if !Task.isCancelled { message.wrappedValue = nil }
					}
					.accessibilityAddTraits(.updatesFrequently)
			}
		}
		.animation(MaskinMotion.quick, value: message.wrappedValue)
	}
}
