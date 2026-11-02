import MaskinDesign
import MaskinUI
import SwiftUI

/// The frame and buttons the agent-request cards share (Connect, Computer, integration access),
/// in the look of the question card.
extension View {
	func requestCardFrame() -> some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
		return padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: shape)
			.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.padding(.top, MaskinSpace.s3)
			.accessibilityElement(children: .contain)
	}
}

/// A full-width capsule button: filled when primary, outlined otherwise.
struct RequestCardButton: View {
	let title: String
	var primary = false
	var disabled = false
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.light)
			action()
		} label: {
			Text(title)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(primary ? MaskinSurface.onInverse : MaskinColor.ink)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				.background {
					if primary {
						Capsule().fill(MaskinSurface.inverse)
					} else {
						Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1)
					}
				}
				.opacity(disabled ? 0.35 : 1)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(disabled)
	}
}

/// What a card shows once it has been answered: an icon and one line.
struct RequestCardSettled: View {
	let symbol: String
	let text: String

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
			Image(systemName: symbol).foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
			Text(text).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
		}
		.accessibilityElement(children: .combine)
	}
}

/// A request card's heading: the ask as a headline over one quieter line (v3 cards 4a to 4c).
struct RequestCardTitle: View {
	let title: String
	var subtitle: String?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Text(title)
				.maskinText(.headline).foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
			if let subtitle, !subtitle.isEmpty {
				Text(subtitle)
					.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}

/// One labelled fact in a request card ("Access", "Lasts", "Shared"): a small label over its value,
/// with room for a trailing control. Rows stack under a hairline.
struct RequestCardRow<Trailing: View>: View {
	let label: String
	let value: String
	var monospaced = false
	@ViewBuilder var trailing: Trailing

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(label).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				Text(value)
					.maskinText(.subhead)
					.monospaced(monospaced)
					.foregroundStyle(MaskinColor.ink2)
					.fixedSize(horizontal: false, vertical: true)
					.textSelection(.enabled)
			}
			Spacer(minLength: MaskinSpace.s3)
			trailing
		}
		.padding(.vertical, MaskinSpace.s4)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(alignment: .top) { MaskinSurface.line.frame(height: 1) }
		.accessibilityElement(children: .combine)
	}
}

extension RequestCardRow where Trailing == EmptyView {
	init(label: String, value: String, monospaced: Bool = false) {
		self.init(label: label, value: value, monospaced: monospaced) { EmptyView() }
	}
}
