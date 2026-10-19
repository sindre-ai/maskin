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
			result[lower..<upper].backgroundColor = MaskinSurface.fillStrong
			result[lower..<upper].foregroundColor = MaskinColor.ink
		}
		return result
	}
}

/// One search hit in the v5 shape: a type-coloured dot, the highlighted title (with a muted
/// snippet under it when the match is in the body) and the type as a mono label at the end.
struct SearchResultRow: View {
	let result: SearchResult
	let query: String

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			dot
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HighlightedText(text: result.title, query: query)
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2)
				if !snippet.isEmpty {
					HighlightedText(text: snippet, query: query)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(2)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			MonoLabel(result.kindLabel)
		}
		.padding(.vertical, MaskinSpace.s3)
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
	}

	private var snippet: String {
		SearchHighlight.snippet(of: result.snippet, around: query)
	}

	private var dot: some View {
		RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
			.fill(dotColor)
			.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
			.accessibilityHidden(true)
	}

	private var dotColor: Color {
		switch result.kind {
		case .object: MaskinObjectType.dotColor(for: result.detail ?? "task")
		case .chat, .agent, .file: MaskinColor.ink5
		}
	}
}
