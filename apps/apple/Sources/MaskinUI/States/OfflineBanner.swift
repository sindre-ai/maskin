import MaskinDesign
import SwiftUI

/// Amber notice shown while the device is offline (the caller owns connectivity state).
public struct OfflineBanner: View {
	private let isVisible: Bool
	private let message: String
	private let retry: (() -> Void)?

	/// `retry`: when set, a trailing "Retry" button runs it (the caller wires the real refetch).
	public init(
		isVisible: Bool = true, message: String = "Can't reach Maskin. Decisions queue offline.",
		retry: (() -> Void)? = nil
	) {
		self.isVisible = isVisible
		self.message = message
		self.retry = retry
	}

	public var body: some View {
		if isVisible {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "wifi.slash").accessibilityHidden(true)
				Text(message).maskinText(.subhead)
				if let retry {
					Spacer(minLength: MaskinSpace.s3)
					Button("Retry", action: retry)
						.maskinText(.subhead)
						.fontWeight(.semibold)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
						.buttonStyle(.plain)
				}
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
			.accessibilityElement(children: .contain)
			.transition(.move(edge: .top).combined(with: .opacity))
		}
	}
}

#Preview("Offline — light") {
	OfflineBanner().padding().background(MaskinSurface.grouped).preferredColorScheme(.light)
}
#Preview("Offline — retry") {
	OfflineBanner(retry: {}).padding().background(MaskinSurface.grouped)
}
#Preview("Offline — dark") {
	OfflineBanner().padding().background(MaskinSurface.grouped).preferredColorScheme(.dark)
}
