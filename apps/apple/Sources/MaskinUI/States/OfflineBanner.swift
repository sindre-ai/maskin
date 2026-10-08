import MaskinDesign
import SwiftUI

/// Amber notice shown while the device is offline (the caller owns connectivity state).
public struct OfflineBanner: View {
	private let isVisible: Bool
	private let message: String

	public init(isVisible: Bool = true, message: String = "You are offline. Changes will sync when reconnected.") {
		self.isVisible = isVisible
		self.message = message
	}

	public var body: some View {
		if isVisible {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "wifi.slash").accessibilityHidden(true)
				Text(message).maskinText(.subhead)
			}
			.foregroundStyle(MaskinColor.noticeFg)
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.vertical, MaskinSpace.s5)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
					.strokeBorder(MaskinColor.noticeBd, lineWidth: 1)
			)
			.accessibilityElement(children: .combine)
			.transition(.move(edge: .top).combined(with: .opacity))
		}
	}
}

#Preview("Offline — light") {
	OfflineBanner().padding().background(MaskinSurface.grouped).preferredColorScheme(.light)
}
#Preview("Offline — dark") {
	OfflineBanner().padding().background(MaskinSurface.grouped).preferredColorScheme(.dark)
}
