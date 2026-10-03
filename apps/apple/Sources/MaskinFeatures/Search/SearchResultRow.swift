import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Text with every occurrence of `query` emphasised.
struct HighlightedText: View {
	let text: String
	let query: String

	var body: some View {
		Text(attributed)
	}

	var attributed: AttributedString {
		var result = AttributedString(text)
		for range in SearchHighlight.ranges(of: query, in: text) {
			guard let lower = AttributedString.Index(range.lowerBound, within: result),
				let upper = AttributedString.Index(range.upperBound, within: result)
			else { continue }
			result[lower..<upper].backgroundColor = MaskinColor.accentTint
			result[lower..<upper].foregroundColor = MaskinColor.accentDeep
		}
		return result
	}
}

/// One search hit: kind glyph, highlighted title, muted subtitle and a snippet around the match.
struct SearchResultRow: View {
	let result: SearchResult
	let query: String

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			leading
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				HighlightedText(text: result.title, query: query)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2)
				HStack(spacing: MaskinSpace.s3) {
					if let label = kindLabel { MonoLabel(label) }
					if !result.subtitle.isEmpty {
						Text(result.subtitle).lineLimit(1)
					}
					if result.updatedAt != nil {
						Text("·")
						RelativeTime(result.updatedAt, style: .compact)
					}
				}
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
				if !snippet.isEmpty {
					HighlightedText(text: snippet, query: query)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(2)
				}
			}
			Spacer(minLength: MaskinSpace.s2)
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
	}

	private var snippet: String {
		SearchHighlight.snippet(of: result.snippet, around: query)
	}

	/// Objects lead with their type; the other kinds are named by their group.
	private var kindLabel: String? {
		switch result.kind {
		case .object: result.detail
		case .chat: "Chat"
		case .agent: "Agent"
		case .file: nil
		}
	}

	@ViewBuilder private var leading: some View {
		switch result.kind {
		case .object:
			TypeBadge(result.detail ?? "task", style: .tile)
		case .agent:
			ActorAvatar(name: result.title, kind: .agent, seed: result.entityId)
		case .chat:
			glyph("bubble.left.and.bubble.right")
		case .file:
			glyph("doc.text")
		}
	}

	private func glyph(_ name: String) -> some View {
		Image(systemName: name)
			.font(.system(size: MaskinFontSize.t16))
			.foregroundStyle(MaskinColor.ink4)
			.frame(width: MaskinSpace.s13, height: MaskinSpace.s13)
			.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.input))
			.accessibilityHidden(true)
	}
}
