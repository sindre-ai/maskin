import MaskinDesign
import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

extension EnvironmentValues {
	/// Offered every tapped markdown link before the web policy applies. Return `true` when the
	/// app took it (a Maskin object/chat link opens in the app instead of the browser). `MaskinUI`
	/// can't know the app's link shapes, so the app root supplies this.
	@Entry public var markdownInternalLinkHandler: (@MainActor (URL) -> Bool)? = nil
}

/// How compact the rendered markdown is. `document` is the reading scale used on object pages
/// and files; `chat` is the tighter scale for a message in a thread (smaller headings, closer
/// blocks, code with a copy header).
public enum MarkdownStyle: Sendable { case document, chat }

extension EnvironmentValues {
	@Entry var markdownStyle: MarkdownStyle = .document
}

/// Parsed blocks, remembered by source text. A thread re-renders its rows whenever anything in
/// the store changes, and parsing every visible message each time is wasted work.
enum MarkdownParseCache {
	private final class Box: @unchecked Sendable {
		let blocks: [MarkdownBlock]
		init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
	}

	nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
		let cache = NSCache<NSString, Box>()
		cache.countLimit = 300
		return cache
	}()

	/// Sources past this size are parsed each time rather than held (a file preview).
	private static let cacheableUTF8Limit = 20_000

	static func blocks(for source: String, hardBreaks: Bool) -> [MarkdownBlock] {
		guard source.utf8.count <= cacheableUTF8Limit else {
			return MarkdownParser.parse(source, hardBreaks: hardBreaks)
		}
		let key = ((hardBreaks ? "h\u{0}" : "s\u{0}") + source) as NSString
		if let hit = cache.object(forKey: key) { return hit.blocks }
		let blocks = MarkdownParser.parse(source, hardBreaks: hardBreaks)
		cache.setObject(Box(blocks), forKey: key)
		return blocks
	}
}

/// Renders markdown natively. Block structure comes from `MarkdownParser`; inline
/// styling from `AttributedString(markdown:)`, restyled with design tokens.
///
/// The text is untrusted (agents and other people write it), so links are filtered: only
/// http(s) and mailto survive, and an http(s) link asks for confirmation naming its host first.
public struct MarkdownContent: View {
	private let blocks: [MarkdownBlock]
	private let style: MarkdownStyle
	@Environment(\.openURL) private var openURL
	@Environment(\.markdownInternalLinkHandler) private var internalLinkHandler
	@State private var pending: URL?

	/// - Parameter hardBreaks: keep every line break (what a person typed in a chat message).
	public init(_ markdown: String, style: MarkdownStyle = .document, hardBreaks: Bool = false) {
		blocks = MarkdownParseCache.blocks(for: markdown, hardBreaks: hardBreaks)
		self.style = style
	}

	public var body: some View {
		MarkdownBlocksView(blocks: blocks)
			.environment(\.markdownStyle, style)
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
	@Environment(\.markdownStyle) private var style

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
				MarkdownBlockView(block: block)
					.padding(.top, index == 0 ? 0 : Self.gap(after: blocks[index - 1], before: block, style: style))
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// Space between two neighbouring blocks. The reading scale is one even rhythm; in a chat
	/// message a heading binds to what it introduces and a list sits close under its lead-in.
	static func gap(after previous: MarkdownBlock, before next: MarkdownBlock, style: MarkdownStyle) -> CGFloat {
		guard style == .chat else { return MaskinSpace.s7 }
		switch (previous, next) {
		case (.heading, _): return MaskinSpace.s3
		case (_, .heading): return MaskinSpace.s7
		case (.paragraph, .bulletList), (.paragraph, .orderedList): return MaskinSpace.s4
		default: return MaskinSpace.s6
		}
	}
}

private struct MarkdownBlockView: View {
	let block: MarkdownBlock
	@Environment(\.markdownStyle) private var style
	@Environment(\.markdownInternalLinkInfo) private var linkInfo

	var body: some View {
		switch block {
		case .heading(let level, let text):
			inline(text, base: headingFont(level))
				.font(headingFont(level))
				.foregroundStyle(MaskinColor.ink)
				.padding(.top, level <= 2 && style == .document ? MaskinSpace.s2 : 0)
				.accessibilityAddTraits(.isHeader)
		case .paragraph(let text):
			if let link = MarkdownStandaloneLink.match(text), linkInfo?(link.url) != nil {
				// A paragraph that is only an internal link reads as a card, not an underlined address.
				MarkdownLinkCard(url: link.url, title: link.title)
			} else {
				inline(text, base: MaskinTextRole.body.font)
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink2)
					.lineSpacing(MaskinSpace.s2)
			}
		case .bulletList(let items):
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				ForEach(Array(items.enumerated()), id: \.offset) { _, item in
					listRow(marker: "\u{2022}", item: item, isBullet: true)
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
		case .codeBlock(let language, let code):
			MarkdownCodeBlock(language: language, code: code, showsHeader: style == .chat)
		case .table(let header, let alignments, let rows):
			MarkdownTable(header: header, alignments: alignments, rows: rows)
		case .thematicBreak:
			Rectangle().fill(MaskinSurface.line).frame(height: 1)
		}
	}

	private func listRow(marker: String, item: [MarkdownBlock], isBullet: Bool = false) -> some View {
		let task = isBullet ? MarkdownTask.split(item) : nil
		return HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			if let task {
				Image(systemName: task.checked ? "checkmark.square.fill" : "square")
					.maskinText(.body)
					.foregroundStyle(task.checked ? MaskinColor.accentStrong : MaskinColor.ink4)
					.frame(minWidth: MaskinSpace.s8, alignment: .trailing)
					.accessibilityLabel(task.checked ? "Done" : "Not done")
			} else {
				Text(marker).maskinText(.body).foregroundStyle(MaskinColor.ink4)
					.frame(minWidth: MaskinSpace.s8, alignment: .trailing)
			}
			MarkdownBlocksView(blocks: task?.blocks ?? item)
		}
	}

	private func headingFont(_ level: Int) -> Font {
		if style == .chat {
			// A heading inside a message is a label, not a page title.
			switch level {
			case 1: return MaskinTypeface.sans(MaskinFontSize.t17, weight: .bold, relativeTo: .headline)
			case 2: return MaskinTypeface.sans(MaskinFontSize.t16, weight: .bold, relativeTo: .body)
			default: return MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline)
			}
		}
		return switch level {
		case 1: MaskinTypeface.sans(MaskinFontSize.t22, weight: .bold, relativeTo: .title2)
		case 2: MaskinTypeface.sans(MaskinFontSize.t19, weight: .bold, relativeTo: .title3)
		case 3: MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold, relativeTo: .headline)
		default: MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline)
		}
	}

	private func inline(_ markdown: String, base: Font) -> Text {
		Text(MarkdownInline.attributed(markdown, base: base, linkInfo: linkInfo.map { info in { info($0) } }))
	}
}

/// A `- [ ]` / `- [x]` list item: whether it is ticked, and the item with its marker removed.
enum MarkdownTask {
	static func split(_ item: [MarkdownBlock]) -> (checked: Bool, blocks: [MarkdownBlock])? {
		guard case .paragraph(let text)? = item.first else { return nil }
		let checked: Bool
		if text.hasPrefix("[ ] ") || text == "[ ]" {
			checked = false
		} else if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") || text == "[x]" || text == "[X]" {
			checked = true
		} else {
			return nil
		}
		var rest = item
		rest[0] = .paragraph(String(text.dropFirst(4)))
		return (checked, rest)
	}
}

enum MarkdownClipboard {
	static func copy(_ string: String) {
		// Watch and TV have no general pasteboard: Copy is a no-op there.
		#if os(iOS)
		UIPasteboard.general.string = string
		#elseif os(macOS)
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(string, forType: .string)
		#endif
	}
}

/// Fenced code. In a chat message it carries a header with the language and a Copy button; on
/// a document page it is the bare block. Wide lines scroll sideways; code that fits does not
/// sit inside a scroll view at all.
private struct MarkdownCodeBlock: View {
	let language: String?
	let code: String
	let showsHeader: Bool
	@State private var copied = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if showsHeader { header }
			ViewThatFits(in: .horizontal) {
				codeText.fixedSize(horizontal: true, vertical: true)
				ScrollView(.horizontal, showsIndicators: false) { codeText.fixedSize(horizontal: true, vertical: true) }
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: showsHeader ? 1 : 0)
		)
		.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}

	private var codeText: some View {
		Text(SyntaxHighlightCache.attributed(code, language: language))
			.maskinText(.mono)
			.foregroundStyle(MaskinColor.ink2)
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, showsHeader ? MaskinSpace.s5 : MaskinSpace.s7)
			#if os(iOS) || os(macOS)
			.textSelection(.enabled)
			#endif
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s4) {
			Text((language ?? "code").uppercased())
				.maskinText(.microLabel).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			Spacer(minLength: 0)
			Button {
				MarkdownClipboard.copy(code)
				MaskinHaptics.play(.selection)
				copied = true
				Task {
					try? await Task.sleep(for: .seconds(1.6))
					copied = false
				}
			} label: {
				Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
					.maskinText(.caption)
					.foregroundStyle(copied ? MaskinColor.accentStrong : MaskinColor.ink3)
					.padding(.horizontal, MaskinSpace.s4)
					.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s2)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(copied ? "Code copied" : "Copy code")
		}
		.padding(.leading, MaskinSpace.s7)
		.padding(.trailing, MaskinSpace.s3)
		.overlay(alignment: .bottom) { Rectangle().fill(MaskinSurface.line).frame(height: 1) }
	}
}

/// A pipe table. Every column is as wide as its widest cell (a cell wraps past `maxCellWidth`),
/// every row as tall as its tallest wrapped cell, and the table scrolls sideways when it is wider
/// than the message. Columns never share out the message's width between them: that squeezes the
/// first column until words break mid-way. (`Grid` and a hugging `ViewThatFits` were tried; both
/// mis-measured wrapping cells, clipping or overlapping them, so layout is explicit.)
private struct MarkdownTable: View {
	let header: [String]
	let alignments: [MarkdownColumnAlignment]
	let rows: [[String]]

	private static let maxCellWidth: CGFloat = 260
	private static let minCellWidth: CGFloat = 56
	private static let cellPadding = MaskinSpace.s6

	private struct Cell: Identifiable {
		let id: Int
		let text: String
		let row: Int
		let column: Int
	}

	private var cells: [Cell] {
		let all = [header] + rows
		var result: [Cell] = []
		for (r, row) in all.enumerated() {
			for (c, text) in row.enumerated() { result.append(Cell(id: result.count, text: text, row: r, column: c)) }
		}
		return result
	}

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			MarkdownTableLayout(
				columns: header.count, minColumnWidth: Self.minCellWidth + Self.cellPadding * 2,
				maxColumnWidth: Self.maxCellWidth + Self.cellPadding * 2
			) {
				ForEach(cells) { cell($0) }
			}
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1)
			)
		}
		.scrollBounceBehavior(.basedOnSize, axes: .horizontal)
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .contain)
	}

	private func cell(_ cell: Cell) -> some View {
		let isHeader = cell.row == 0
		let alignment = alignments.indices.contains(cell.column) ? alignments[cell.column] : .leading
		let font = isHeader
			? MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline)
			: MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline)
		return Text(MarkdownInline.attributed(cell.text, base: font))
			.font(font)
			.foregroundStyle(isHeader ? MaskinColor.ink : MaskinColor.ink2)
			.multilineTextAlignment(alignment.text)
			.fixedSize(horizontal: false, vertical: true)
			.padding(.horizontal, Self.cellPadding)
			.padding(.vertical, MaskinSpace.s4)
			// Fills the column the layout gives it, so narrower cells align inside it.
			.frame(maxWidth: .infinity, alignment: alignment.frame)
			.background(isHeader ? MaskinSurface.cardInset2 : Color.clear)
			.overlay(alignment: .top) {
				if !isHeader { Rectangle().fill(MaskinSurface.line).frame(height: 1) }
			}
	}
}

/// Lays `columns` cells per row: a column is its widest cell's natural width (within bounds), a
/// row its tallest cell at that column width.
private struct MarkdownTableLayout: Layout {
	let columns: Int
	let minColumnWidth: CGFloat
	let maxColumnWidth: CGFloat

	struct Metrics {
		var widths: [CGFloat] = []
		var heights: [CGFloat] = []
	}

	func makeCache(subviews: Subviews) -> Metrics { Metrics() }

	private func metrics(_ subviews: Subviews, _ cache: inout Metrics) -> Metrics {
		if !cache.widths.isEmpty || columns <= 0 { return cache }
		var widths = [CGFloat](repeating: minColumnWidth, count: columns)
		for (index, view) in subviews.enumerated() {
			let natural = view.sizeThatFits(.unspecified).width
			widths[index % columns] = max(widths[index % columns], min(natural, maxColumnWidth))
		}
		var heights = [CGFloat](repeating: 0, count: (subviews.count + columns - 1) / columns)
		for (index, view) in subviews.enumerated() {
			let height = view.sizeThatFits(ProposedViewSize(width: widths[index % columns], height: nil)).height
			heights[index / columns] = max(heights[index / columns], height)
		}
		cache = Metrics(widths: widths, heights: heights)
		return cache
	}

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics) -> CGSize {
		let m = metrics(subviews, &cache)
		return CGSize(width: m.widths.reduce(0, +), height: m.heights.reduce(0, +))
	}

	func placeSubviews(
		in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics
	) {
		let m = metrics(subviews, &cache)
		var y = bounds.minY
		for row in m.heights.indices {
			var x = bounds.minX
			for column in 0..<columns {
				let index = row * columns + column
				if index < subviews.count {
					subviews[index].place(
						at: CGPoint(x: x, y: y), anchor: .topLeading,
						proposal: ProposedViewSize(width: m.widths[column], height: m.heights[row]))
				}
				x += m.widths[column]
			}
			y += m.heights[row]
		}
	}
}

private extension MarkdownColumnAlignment {
	var text: TextAlignment {
		switch self {
		case .leading: .leading
		case .center: .center
		case .trailing: .trailing
		}
	}
	var frame: Alignment {
		switch self {
		case .leading: .topLeading
		case .center: .top
		case .trailing: .topTrailing
		}
	}
	var horizontal: HorizontalAlignment {
		switch self {
		case .leading: .leading
		case .center: .center
		case .trailing: .trailing
		}
	}
}

/// Inline markdown → `AttributedString`, restyled with tokens. Falls back to the raw text.
///
/// Bold / italic are applied as explicit fonts derived from `base` rather than left as
/// `inlinePresentationIntent`: SwiftUI does not reliably apply those intents on top of a
/// custom (`Font.custom`) font, so `**bold**` rendered as regular weight.
enum MarkdownInline {
	/// - Parameter linkInfo: describes a URL that points inside the app (nil for an outside one), so
	///   an internal link can be drawn as a chip carrying the thing's name.
	static func attributed(
		_ markdown: String, base: Font, linkInfo: ((URL) -> MarkdownLinkInfo?)? = nil
	) -> AttributedString {
		guard
			var attr = try? AttributedString(
				markdown: markdown,
				options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
		else { return AttributedString(markdown) }
		// Internal links whose visible text is just the address: shown by name instead.
		var renames: [(range: Range<AttributedString.Index>, text: String)] = []
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
			} else if let link = run.link, let info = linkInfo?(link) {
				// A link into the app: a tinted chip, no underline, opened in the app.
				attr[run.range].foregroundColor = MaskinColor.accentStrong
				attr[run.range].backgroundColor = MaskinColor.accentTint
				attr[run.range].font = base.weight(.semibold)
				attr[run.range].underlineStyle = nil
				let visible = String(attr[run.range].characters).trimmingCharacters(in: .whitespaces)
				if visible == link.absoluteString || visible.hasPrefix("http") || visible.hasPrefix("maskin:") {
					renames.append((run.range, info.title ?? info.kindLabel))
				}
			} else if let link = run.link, MarkdownLinkPolicy.decision(for: link) == .reject {
				// tel:, sms:, facetime:, maskin:// ...: shown as plain text, never tappable.
				attr[run.range].link = nil
			} else if run.link != nil {
				attr[run.range].foregroundColor = MaskinColor.accentStrong
				attr[run.range].underlineStyle = .single
			}
		}
		// Back to front, so earlier ranges stay valid while text changes length.
		for rename in renames.reversed() { attr.characters.replaceSubrange(rename.range, with: rename.text) }
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
