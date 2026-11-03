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

/// A request card's heading: a glyph tile, the ask as a headline and one quieter line (v3 cards 4a to 4c).
struct RequestCardTitle: View {
	let title: String
	var subtitle: String?
	var symbol: String?

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			if let symbol {
				Image(systemName: symbol)
					.maskinSymbol(MaskinFontSize.t16)
					.foregroundStyle(MaskinColor.ink2)
					.frame(width: MaskinSpace.s13, height: MaskinSpace.s13)
					.background(MaskinSurface.grouped, in: RoundedRectangle(cornerRadius: MaskinRadius.input, style: .continuous))
					.accessibilityHidden(true)
			}
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
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}

/// One labelled fact in a request card ("Access", "Lasts"): the label and its value in an inset
/// row, with room for a trailing control. A long value (a command) stacks under its label.
struct RequestCardRow<Trailing: View>: View {
	let label: String
	let value: String
	var monospaced = false
	@ViewBuilder var trailing: Trailing

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
			Text(label).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			Text(value)
				.maskinText(monospaced ? .caption : .subhead)
				.monospaced(monospaced)
				.foregroundStyle(MaskinColor.ink2)
				.fixedSize(horizontal: false, vertical: true)
				.textSelection(.enabled)
				.frame(maxWidth: .infinity, alignment: .leading)
			trailing
		}
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.vertical, MaskinSpace.s5)
		.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
		.background(MaskinSurface.grouped, in: RoundedRectangle(cornerRadius: MaskinRadius.input, style: .continuous))
		.accessibilityElement(children: .combine)
	}
}

extension RequestCardRow where Trailing == EmptyView {
	init(label: String, value: String, monospaced: Bool = false) {
		self.init(label: label, value: value, monospaced: monospaced) { EmptyView() }
	}
}

/// A declined card's one line, with Ask again when the card can send a normal chat message.
struct RequestCardDeclined: View {
	let symbol: String
	let text: String
	/// Nil when there is no chat to ask in (a helper agent's own session).
	var onAskAgain: (() -> Void)?

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
			RequestCardSettled(symbol: symbol, text: text)
			Spacer(minLength: MaskinSpace.s3)
			if let onAskAgain {
				Button("Ask again") {
					MaskinHaptics.play(.light)
					onAskAgain()
				}
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.sigInk)
				.buttonStyle(.maskinPressed)
			}
		}
	}
}
