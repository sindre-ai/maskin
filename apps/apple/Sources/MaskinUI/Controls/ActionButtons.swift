import MaskinDesign
import SwiftUI

/// Filled, inverted primary action ("Approve"). 50pt tall, full width by default.
public struct PrimaryActionButtonStyle: ButtonStyle {
	@Environment(\.isEnabled) private var isEnabled

	public init() {}

	public func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.maskinText(.headline)
			.foregroundStyle(MaskinSurface.onInverse)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s3)
			.padding(.horizontal, MaskinSpace.s9)
			.background(MaskinSurface.inverse, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
			.opacity(isEnabled ? 1 : 0.4)
			.scaleEffect(configuration.isPressed ? 0.985 : 1)
			.animation(MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(Rectangle())
	}
}

/// Outlined secondary action ("Hold") that pairs with the primary.
public struct SecondaryActionButtonStyle: ButtonStyle {
	@Environment(\.isEnabled) private var isEnabled

	public init() {}

	public func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.maskinText(.headline)
			.foregroundStyle(MaskinColor.ink)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s3)
			.padding(.horizontal, MaskinSpace.s9)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1)
			)
			.opacity(isEnabled ? 1 : 0.4)
			.scaleEffect(configuration.isPressed ? 0.985 : 1)
			.animation(MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(Rectangle())
	}
}

extension ButtonStyle where Self == PrimaryActionButtonStyle {
	public static var primaryAction: PrimaryActionButtonStyle { .init() }
}

extension ButtonStyle where Self == SecondaryActionButtonStyle {
	public static var secondaryAction: SecondaryActionButtonStyle { .init() }
}

#Preview("Actions — light") { ActionsGallery().preferredColorScheme(.light) }
#Preview("Actions — dark") { ActionsGallery().preferredColorScheme(.dark) }

private struct ActionsGallery: View {
	var body: some View {
		VStack(spacing: MaskinSpace.s5) {
			Button("Approve") {}.buttonStyle(.primaryAction)
			Button("Hold") {}.buttonStyle(.secondaryAction)
			Button("Disabled") {}.buttonStyle(.primaryAction).disabled(true)
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}
