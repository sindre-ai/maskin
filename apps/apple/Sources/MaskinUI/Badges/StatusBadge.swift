import MaskinDesign
import SwiftUI

/// A status as a tinted pill, a dot + word, or the bare coloured word.
public struct StatusBadge: View {
	public enum Style: Sendable { case pill, dotWord, word }

	private let status: String
	private let style: Style

	public init(_ status: String, style: Style = .pill) {
		self.status = status
		self.style = style
	}

	public var body: some View {
		let colors = MaskinStatus.colors(for: status)
		Group {
			switch style {
			case .pill:
				Text(MaskinStatus.label(for: status))
					.maskinText(.caption)
					.foregroundStyle(colors.fg)
					.padding(.horizontal, MaskinSpace.s4)
					.padding(.vertical, MaskinSpace.s1)
					.background(colors.bg, in: Capsule())
			case .dotWord:
				HStack(spacing: MaskinSpace.s2) {
					Circle().fill(colors.fg).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
					Text(MaskinStatus.label(for: status)).maskinText(.caption).foregroundStyle(colors.fg)
				}
			case .word:
				Text(MaskinStatus.sentenceLabel(for: status))
					.maskinText(.caption)
					.foregroundStyle(colors.fg)
			}
		}
		.lineLimit(1)
		.fixedSize()
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Status \(MaskinStatus.label(for: status))")
	}
}

#Preview("Status — light") {
	StatusBadgeGallery().preferredColorScheme(.light)
}
#Preview("Status — dark") {
	StatusBadgeGallery().preferredColorScheme(.dark)
}

private struct StatusBadgeGallery: View {
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			ForEach(["new", "in_progress", "active", "in_review", "blocked", "failed", "waiting_for_input", "custom"], id: \.self) {
				StatusBadge($0)
			}
			StatusBadge("blocked", style: .dotWord)
			StatusBadge("in_review", style: .word)
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}
