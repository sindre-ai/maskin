import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The strip inside the composer bar, above the field, while replying to or editing a message: a
/// 3pt signal rule, a bold label ("Replying to Forge" / "Editing message"), the quoted text on one
/// line, and a ✕ that drops the quote. Spec 7 §1 → Quote strip.
struct ComposerQuoteStrip: View {
	let label: String
	let text: String
	let onClear: () -> Void

	private static let rule: CGFloat = MaskinSpace.s1 + 1

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s5) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
				.fill(MaskinColor.sig)
				.frame(width: Self.rule)
			VStack(alignment: .leading, spacing: MaskinSpace.s1 / 2) {
				Text(label)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.sigInk)
					.lineLimit(1)
				Text(text)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
					.truncationMode(.tail)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			Button {
				MaskinHaptics.play(.selection)
				onClear()
			} label: {
				Image(systemName: "xmark")
					.maskinSymbol(MaskinFontSize.t14, weight: .bold)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.contentShape(Circle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel(label.hasPrefix("Editing") ? "Cancel editing" : "Cancel reply")
		}
		.fixedSize(horizontal: false, vertical: true)
		.padding(.leading, MaskinSpace.s3)
		.accessibilityElement(children: .contain)
	}

	/// The strip's label and one-line text for the model's current state, or nil when there is no quote.
	static func content(for model: ChatComposerModel) -> (label: String, text: String)? {
		if let editing = model.editing {
			return ("Editing message", firstLine(editing.originalText))
		}
		if let reply = model.replyTo {
			return ("Replying to \(reply.name)", firstLine(reply.text))
		}
		return nil
	}

	private static func firstLine(_ text: String) -> String {
		text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
			.first { !$0.isEmpty } ?? ""
	}
}
