import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A status category's mark (handoff 1E): hollow grey circle for Backlog, a Patina dot for Needs
/// you, pulsing Patina bars for Active, an ink check circle for Done, a struck grey circle for
/// Cancelled. The category decides, never the status's name.
struct StatusCategoryGlyph: View {
	let category: StatusCategory
	var size: CGFloat = MaskinSpace.s5
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		Group {
			switch category {
			case .backlog:
				Circle().strokeBorder(MaskinColor.ink5, lineWidth: 1.5)
			case .needsYou:
				Circle().fill(MaskinColor.sig).padding(size * 0.2)
			case .active:
				Image(systemName: "waveform")
					.font(.system(size: size, weight: .bold))
					.foregroundStyle(MaskinColor.sigInk)
					.symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
			case .done:
				Image(systemName: "checkmark.circle.fill")
					.font(.system(size: size))
					.foregroundStyle(MaskinColor.doneFg)
			case .cancelled:
				Image(systemName: "circle.slash")
					.font(.system(size: size))
					.foregroundStyle(MaskinColor.ink5)
			}
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}

/// A status as the lists show it: its category mark, then the word (struck through when cancelled).
struct StatusWord: View {
	let status: String
	let tone: Color
	var font: MaskinTextRole = .subhead

	var body: some View {
		let category = StatusCategory.of(status)
		HStack(spacing: MaskinSpace.s2) {
			StatusCategoryGlyph(category: category, size: MaskinSpace.s5)
			Text(MaskinStatus.label(for: status))
				.maskinText(font).fontWeight(.semibold)
				.strikethrough(category == .cancelled)
				.foregroundStyle(tone)
				.lineLimit(1)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(MaskinStatus.label(for: status))
	}
}

/// The amber notice of the empty/error states (handoff 1D): a title, one sentence and at most one
/// action. Used for "Can't reach Maskin" and for a failed load; never for anything but errors.
struct AmberNotice: View {
	let title: String
	let message: String
	var actionTitle: String?
	var action: (() -> Void)?

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			Image(systemName: "exclamationmark.circle.fill")
				.foregroundStyle(MaskinSurface.amberForeground)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(title).maskinText(.subhead).fontWeight(.semibold)
				Text(message).maskinText(.subhead)
			}
			.foregroundStyle(MaskinSurface.amberForeground)
			Spacer(minLength: MaskinSpace.s3)
			if let actionTitle, let action {
				Button(actionTitle, action: action)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinSurface.amberForeground)
					.frame(minHeight: MaskinSpace.touchMin)
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s5)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(
			MaskinSurface.amberBackground,
			in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
		)
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(MaskinSurface.amberBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
	}
}

extension AmberNotice {
	/// "Can't reach Maskin" with the time of what is still on screen.
	static func offline(since: Date?, retry: @escaping () -> Void) -> AmberNotice {
		AmberNotice(
			title: "Can't reach Maskin", message: OfflineCopy.message(since: since),
			actionTitle: "Retry", action: retry)
	}
}

enum OfflineCopy {
	/// "Showing what we had at 08:14. Decisions queue offline." (time omitted when unknown).
	static func message(since: Date?) -> String {
		guard let since else { return "Decisions queue offline." }
		return "Showing what we had at \(since.formatted(date: .omitted, time: .shortened)). Decisions queue offline."
	}
}
