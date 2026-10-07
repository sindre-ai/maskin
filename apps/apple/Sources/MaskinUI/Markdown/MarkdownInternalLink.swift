import MaskinDesign
import SwiftUI

/// What the app knows about a URL that points inside Maskin (an object, a chat): enough to draw
/// it as a chip or card with a real name instead of an underlined address.
public struct MarkdownLinkInfo: Equatable, Sendable {
	/// SF Symbol for the kind of thing it opens.
	public var symbol: String
	/// "Bet", "Task", "Chat": what it is, shown when no title is known.
	public var kindLabel: String
	/// The thing's own name once it has been looked up; nil while unresolved.
	public var title: String?

	public init(symbol: String, kindLabel: String, title: String? = nil) {
		self.symbol = symbol
		self.kindLabel = kindLabel
		self.title = title
	}
}

extension EnvironmentValues {
	/// Describes a URL that points inside the app, or nil for an outside link. Called while a view
	/// builds its body, so an implementation that reads observable state re-renders the text when
	/// a title arrives. Supplied by the app root, which knows its own link shapes.
	@Entry public var markdownInternalLinkInfo: (@MainActor (URL) -> MarkdownLinkInfo?)? = nil
}

/// A link that is the whole of a message or paragraph: `[Title](url)` or a bare address.
public enum MarkdownStandaloneLink {
	public struct Match: Equatable, Sendable {
		public var url: URL
		/// The link's own text, when it has words (not just the address again).
		public var title: String?
	}

	private static let titled = try! NSRegularExpression(pattern: #"^\[([^\]\n]+)\]\(([^)\s]+)\)$"#)
	private static let bare = try! NSRegularExpression(pattern: #"^<?((?:https?|maskin)://[^\s<>]+)>?$"#)

	public static func match(_ text: String) -> Match? {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		let whole = NSRange(trimmed.startIndex..., in: trimmed)
		if let m = titled.firstMatch(in: trimmed, range: whole),
			let titleRange = Range(m.range(at: 1), in: trimmed), let urlRange = Range(m.range(at: 2), in: trimmed),
			let url = URL(string: String(trimmed[urlRange]))
		{
			let title = String(trimmed[titleRange]).trimmingCharacters(in: .whitespaces)
			let repeatsAddress = title == url.absoluteString
			return Match(url: url, title: title.isEmpty || repeatsAddress ? nil : title)
		}
		if let m = bare.firstMatch(in: trimmed, range: whole), let urlRange = Range(m.range(at: 1), in: trimmed),
			let url = URL(string: String(trimmed[urlRange]))
		{
			return Match(url: url, title: nil)
		}
		return nil
	}
}

/// An internal link shown as a card: a tinted symbol, the thing's name, and what kind of thing it
/// is. Tapping opens it in the app through the same handler as any other internal link.
public struct MarkdownLinkCard: View {
	private let url: URL
	private let title: String?
	@Environment(\.markdownInternalLinkInfo) private var linkInfo
	@Environment(\.markdownInternalLinkHandler) private var internalHandler
	@Environment(\.openURL) private var openURL

	public init(url: URL, title: String? = nil) {
		self.url = url
		self.title = title
	}

	public var body: some View {
		if let info = linkInfo?(url) {
			let name = title ?? info.title ?? info.kindLabel
			Button {
				if internalHandler?(url) != true { openURL(url) }
			} label: {
				HStack(spacing: MaskinSpace.s6) {
					Image(systemName: info.symbol)
						.font(.system(size: MaskinFontSize.t15, weight: .semibold))
						.foregroundStyle(MaskinColor.ink)
						.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
						.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
						.accessibilityHidden(true)
					VStack(alignment: .leading, spacing: 0) {
						Text(name).maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(MaskinColor.ink).lineLimit(2).multilineTextAlignment(.leading)
						if name != info.kindLabel {
							Text(info.kindLabel).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						}
					}
					Spacer(minLength: 0)
					Image(systemName: "chevron.right").font(.caption.weight(.semibold))
						.foregroundStyle(MaskinColor.ink5).accessibilityHidden(true)
				}
				.padding(.horizontal, MaskinSpace.s6)
				.padding(.vertical, MaskinSpace.s5)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				.overlay(
					RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
						.strokeBorder(MaskinSurface.line, lineWidth: 1))
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(name == info.kindLabel ? name : "\(name), \(info.kindLabel)")
			.accessibilityHint("Opens in Maskin")
		}
	}
}
