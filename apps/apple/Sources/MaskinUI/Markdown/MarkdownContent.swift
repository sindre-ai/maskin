import MaskinDesign
import SwiftUI

/// Renders markdown natively. Block structure comes from `MarkdownParser`; inline
/// styling from `AttributedString(markdown:)`, restyled with design tokens.
public struct MarkdownContent: View {
	private let blocks: [MarkdownBlock]

	public init(_ markdown: String) {
		blocks = MarkdownParser.parse(markdown)
	}

	public var body: some View {
		MarkdownBlocksView(blocks: blocks)
	}
}

struct MarkdownBlocksView: View {
	let blocks: [MarkdownBlock]

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
				MarkdownBlockView(block: block)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

private struct MarkdownBlockView: View {
	let block: MarkdownBlock

	var body: some View {
		switch block {
		case .heading(let level, let text):
			inline(text, base: headingFont(level))
				.font(headingFont(level))
				.foregroundStyle(MaskinColor.ink)
				.padding(.top, level <= 2 ? MaskinSpace.s2 : 0)
				.accessibilityAddTraits(.isHeader)
		case .paragraph(let text):
			inline(text, base: MaskinTextRole.body.font)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink2)
				.lineSpacing(MaskinSpace.s2)
		case .bulletList(let items):
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				ForEach(Array(items.enumerated()), id: \.offset) { _, item in
					listRow(marker: "\u{2022}", item: item)
				}
			}
		case .orderedList(let start, let items):
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				ForEach(Array(items.enumerated()), id: \.offset) { index, item in
					listRow(marker: "\(start + index).", item: item)
				}
			}
		case .blockquote(let inner):
			HStack(alignment: .top, spacing: MaskinSpace.s5) {
				RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
					.fill(MaskinColor.ruleStrong)
					.frame(width: MaskinSpace.s2)
				MarkdownBlocksView(blocks: inner).foregroundStyle(MaskinColor.ink3)
			}
		case .codeBlock(_, let code):
			ScrollView(.horizontal, showsIndicators: false) {
				Text(code)
					.maskinText(.mono)
					.foregroundStyle(MaskinColor.ink2)
					.padding(MaskinSpace.s7)
					#if os(iOS) || os(macOS)
					.textSelection(.enabled)
					#endif
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		case .thematicBreak:
			Rectangle().fill(MaskinSurface.line).frame(height: 1)
		}
	}

	private func listRow(marker: String, item: [MarkdownBlock]) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Text(marker).maskinText(.body).foregroundStyle(MaskinColor.ink4)
				.frame(minWidth: MaskinSpace.s8, alignment: .trailing)
			MarkdownBlocksView(blocks: item)
		}
	}

	private func headingFont(_ level: Int) -> Font {
		switch level {
		case 1: MaskinTypeface.sans(MaskinFontSize.t22, weight: .bold, relativeTo: .title2)
		case 2: MaskinTypeface.sans(MaskinFontSize.t19, weight: .bold, relativeTo: .title3)
		case 3: MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold, relativeTo: .headline)
		default: MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline)
		}
	}

	private func inline(_ markdown: String, base: Font) -> Text {
		Text(MarkdownInline.attributed(markdown, base: base))
	}
}

/// Inline markdown → `AttributedString`, restyled with tokens. Falls back to the raw text.
///
/// Bold / italic are applied as explicit fonts derived from `base` rather than left as
/// `inlinePresentationIntent`: SwiftUI does not reliably apply those intents on top of a
/// custom (`Font.custom`) font, so `**bold**` rendered as regular weight.
enum MarkdownInline {
	static func attributed(_ markdown: String, base: Font) -> AttributedString {
		guard
			var attr = try? AttributedString(
				markdown: markdown,
				options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
		else { return AttributedString(markdown) }
		for run in attr.runs {
			let intent = run.inlinePresentationIntent ?? []
			if intent.contains(.code) {
				attr[run.range].font = MaskinTypeface.mono(MaskinFontSize.t14, relativeTo: .body)
				attr[run.range].backgroundColor = MaskinSurface.fill
			} else if intent.contains(.stronglyEmphasized) || intent.contains(.emphasized) {
				var font = base
				if intent.contains(.stronglyEmphasized) { font = font.bold() }
				if intent.contains(.emphasized) { font = font.italic() }
				attr[run.range].font = font
			}
			if intent.contains(.strikethrough) { attr[run.range].strikethroughStyle = .single }
			if run.link != nil {
				attr[run.range].foregroundColor = MaskinColor.accentStrong
				attr[run.range].underlineStyle = .single
			}
		}
		return attr
	}
}

#Preview("Markdown — light") { MarkdownGallery().preferredColorScheme(.light) }
#Preview("Markdown — dark") { MarkdownGallery().preferredColorScheme(.dark) }

private struct MarkdownGallery: View {
	private static let sample = """
		# Weekly brief
		Three things changed: **pricing** moved, the `onboarding` flow was *simplified*, and [the report](https://maskin.io) is live.

		## Decisions
		- Approve the pricing change
		- Hold the launch
		  - until legal signs off
		1. First
		2. Second

		> Customers keep asking for export.

		```swift
		let x = 42
		```

		---
		"""
	var body: some View {
		ScrollView { MarkdownContent(Self.sample).padding(MaskinSpace.s9) }
			.background(MaskinSurface.grouped)
	}
}
