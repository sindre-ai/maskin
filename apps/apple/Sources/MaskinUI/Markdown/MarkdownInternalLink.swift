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
	/// The link leaves the app (a GitHub pull request): drawn as a chip with a small arrow, and a tap
	/// asks "Open this link?" first.
	public var leavesApp: Bool

	public init(symbol: String, kindLabel: String, title: String? = nil, leavesApp: Bool = false) {
		self.symbol = symbol
		self.kindLabel = kindLabel
		self.title = title
		self.leavesApp = leavesApp
	}
}

extension EnvironmentValues {
	/// Describes a URL that points inside the app, or nil for an outside link. Called while a view
	/// builds its body, so an implementation that reads observable state re-renders the text when
	/// a title arrives. Supplied by the app root, which knows its own link shapes.
	@Entry public var markdownInternalLinkInfo: (@MainActor (URL) -> MarkdownLinkInfo?)? = nil
}

/// How a link that stands alone on its line is drawn.
public enum MarkdownStandaloneLinkStyle {
	/// The card the app supplies for it (an object's card face).
	case card(AnyView)
	/// An inline link, as inside a sentence: a link the message has no room to draw as a card.
	case inline
	/// The thin icon-and-name card.
	case simple
}

extension EnvironmentValues {
	/// Chooses how a link that stands alone on its line is drawn. Nil, as in previews and tests,
	/// draws every internal link as the thin card. Supplied by the app root, which knows what a link
	/// points at; a chat message overrides it, since it places its own cards.
	@Entry public var markdownStandaloneLink: (@MainActor (URL, String?) -> MarkdownStandaloneLinkStyle)? = nil
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

/// An internal link shown as a thin card: a tinted symbol, the thing's name, and what kind of thing
/// it is. Objects and files have the fuller card face instead (see `markdownStandaloneLink`); this
/// stays for chats, agents and the other links. Tapping opens it in the app through the same
/// handler as any other internal link. A link that leaves the app is a chip instead.
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
			if info.leavesApp {
				outsideChip(info, name: name)
			} else {
				card(info, name: name)
			}
		}
	}

	private func open() {
		if internalHandler?(url) != true { openURL(url) }
	}

	/// A link that leaves the app: the kind's symbol, the name and a small arrow, in a capsule. The
	/// tap goes to the outside-link path, which asks before it opens anything.
	private func outsideChip(_ info: MarkdownLinkInfo, name: String) -> some View {
		Button(action: open) {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: info.symbol)
					.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
					.accessibilityHidden(true)
				Text(name).maskinText(.subhead).fontWeight(.semibold).lineLimit(1)
				Image(systemName: "arrow.up.right")
					.maskinSymbol(MaskinFontSize.t11, weight: .semibold)
					.foregroundStyle(MaskinColor.ink4)
					.accessibilityHidden(true)
			}
			.foregroundStyle(MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s5)
			.padding(.vertical, MaskinSpace.s3)
			.background(MaskinSurface.fill, in: Capsule())
			// The capsule is smaller than a finger; the tap area is not.
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityLabel("\(info.kindLabel): \(name)")
		.accessibilityHint("Opens outside Maskin")
	}

	private func card(_ info: MarkdownLinkInfo, name: String) -> some View {
		Button(action: open) {
			HStack(spacing: MaskinSpace.s6) {
				Image(systemName: info.symbol)
					.maskinSymbol(MaskinFontSize.t15, weight: .semibold)
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
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(name == info.kindLabel ? name : "\(name), \(info.kindLabel)")
		.accessibilityHint("Opens in Maskin")
	}
}
