import MaskinDesign
import SwiftUI

extension EnvironmentValues {
	/// Offered every tapped markdown link before the web policy applies. Return `true` when the
	/// app took it (a Maskin object/chat link opens in the app instead of the browser). `MaskinUI`
	/// can't know the app's link shapes, so the app root supplies this.
	@Entry public var markdownInternalLinkHandler: (@MainActor (URL) -> Bool)? = nil
}

/// Renders markdown natively. Block structure comes from `MarkdownParser`; inline
/// styling from `AttributedString(markdown:)`, restyled with design tokens.
///
/// The text is untrusted (agents and other people write it), so links are filtered: only
/// http(s) and mailto survive, and an http(s) link asks for confirmation naming its host first.
public struct MarkdownContent: View {
	private let blocks: [MarkdownBlock]
	@Environment(\.openURL) private var openURL
	@Environment(\.markdownInternalLinkHandler) private var internalLinkHandler
	@State private var pending: URL?

	public init(_ markdown: String) {
		blocks = MarkdownParser.parse(markdown)
	}

	public var body: some View {
		MarkdownBlocksView(blocks: blocks)
			.environment(
				\.openURL,
				OpenURLAction { url in
					if internalLinkHandler?(url) == true { return .handled }
					switch MarkdownLinkPolicy.decision(for: url) {
					case .open: return .systemAction
					case .confirm: pending = url; return .handled
					case .reject: return .discarded
					}
				}
			)
			.confirmationDialog(
				"Open this link?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
				titleVisibility: .visible, presenting: pending
			) { url in
				Button("Open \(MarkdownLinkPolicy.host(of: url) ?? "link")") { openURL(url) }
			} message: { url in
				Text(url.absoluteString)
			}
	}
}

/// How a comment marks an `@mention` for the renderer: `[@Name](mention:<actor id>)`.
public enum MarkdownMention {
	public static let scheme = "mention"
}

/// What may happen when a link in untrusted markdown is tapped.
enum MarkdownLinkPolicy {
	enum Decision: Equatable { case open, confirm, reject }

	static func decision(for url: URL) -> Decision {
		switch url.scheme?.lowercased() {
		case "mailto": return url.absoluteString.count > "mailto:".count ? .open : .reject
		case "http", "https": return host(of: url) == nil ? .reject : .confirm
		default: return .reject
		}
	}

	static func host(of url: URL) -> String? {
		guard let host = url.host(percentEncoded: false), !host.isEmpty else { return nil }
		return host
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
			if run.link?.scheme == MarkdownMention.scheme {
				// An @mention: emphasised, never tappable.
				attr[run.range].link = nil
				attr[run.range].foregroundColor = MaskinColor.accentStrong
				attr[run.range].font = base.weight(.semibold)
			} else if let link = run.link, MarkdownLinkPolicy.decision(for: link) == .reject {
				// tel:, sms:, facetime:, maskin:// ...: shown as plain text, never tappable.
				attr[run.range].link = nil
			} else if run.link != nil {
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
