import Foundation

/// An object or a file a chat message links to. Agents refer to their work by a link to its page
/// (`https://maskin.io/<workspace>/objects/<uuid>`, `…/files/<uuid>`); the link is the signal that the
/// reader would want to see what is behind it.
public struct LinkedTarget: Hashable, Sendable, Identifiable {
	public enum Kind: String, Sendable { case object, file }

	public var kind: Kind
	/// Lowercased, so the same thing linked twice is one target.
	public var uuid: String

	public var id: String { key }
	/// `object:<uuid>` / `file:<uuid>`: the cache and de-duplication key.
	public var key: String { "\(kind.rawValue):\(uuid)" }

	public init(kind: Kind, uuid: String) {
		self.kind = kind
		self.uuid = uuid.lowercased()
	}

	private static let hrefPattern = try! NSRegularExpression(
		pattern:
			#"/(objects|files)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)"#,
		options: .caseInsensitive)

	/// The object or file an address points at, if it points at one. Absolute web links and relative
	/// `/<workspace>/objects/<uuid>` paths both count.
	public static func parse(href: String) -> LinkedTarget? {
		let range = NSRange(href.startIndex..., in: href)
		guard let m = hrefPattern.firstMatch(in: href, range: range),
			let kindRange = Range(m.range(at: 1), in: href), let idRange = Range(m.range(at: 2), in: href)
		else { return nil }
		return LinkedTarget(kind: href[kindRange].lowercased() == "files" ? .file : .object, uuid: String(href[idRange]))
	}

	/// Every object and file a text links to, in the order each first appears, without repeats.
	/// Only real links count (`[title](url)`, `<url>` or a bare address), never an id in prose.
	public static func extract(from markdown: String) -> [LinkedTarget] {
		LinkScanCaches.targets.value(for: markdown) { scan(markdown) }
	}

	static func scan(_ markdown: String) -> [LinkedTarget] {
		var seen = Set<String>()
		var found: [LinkedTarget] = []
		for link in LinkScanner.links(in: markdown) {
			guard let target = parse(href: link.href), seen.insert(target.key).inserted else { continue }
			found.append(target)
		}
		return found
	}
}

/// The links of one run of markdown, found without a full parse: enough to tell whether a paragraph
/// is nothing but one link.
enum LinkScanner {
	struct Link {
		var range: Range<String.Index>
		var href: String
		/// `![alt](src)`: a picture, which is not text around a link.
		var isImage: Bool
	}

	private static let pattern = try! NSRegularExpression(
		pattern:
			#"(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|<((?:https?|maskin)://[^\s<>]+)>|((?:https?|maskin)://[^\s<>]+)"#
	)
	/// What can trail a bare address without belonging to it: closing punctuation and emphasis marks.
	private static let trailing = CharacterSet(charactersIn: ".,;:!?)]}'\"*_~")

	/// "`" or "~" when the line opens or closes a fenced block of that kind.
	static func fenceMarker(of line: String) -> Character? {
		let trimmed = line.trimmingCharacters(in: .whitespaces)
		if trimmed.hasPrefix("```") { return "`" }
		if trimmed.hasPrefix("~~~") { return "~" }
		return nil
	}

	private static let inlineCode = try! NSRegularExpression(pattern: #"`[^`\n]*`"#)

	/// The text with fenced code and inline code blanked to spaces (one per UTF-16 unit, so ranges
	/// still line up): a link written as code is a quotation, not a link.
	static func maskingCode(_ text: String) -> String {
		var lines: [String] = []
		var fence: Character?
		for line in text.components(separatedBy: "\n") {
			let marker = fenceMarker(of: line)
			if fence == nil, let marker {
				fence = marker
				lines.append(String(repeating: " ", count: line.utf16.count))
			} else if fence != nil {
				if marker == fence { fence = nil }
				lines.append(String(repeating: " ", count: line.utf16.count))
			} else {
				lines.append(line)
			}
		}
		var masked = lines.joined(separator: "\n")
		for m in inlineCode.matches(in: masked, range: NSRange(masked.startIndex..., in: masked)).reversed() {
			guard let r = Range(m.range, in: masked) else { continue }
			masked.replaceSubrange(r, with: String(repeating: " ", count: m.range.length))
		}
		return masked
	}

	static func links(in source: String) -> [Link] {
		let text = maskingCode(source)
		let whole = NSRange(text.startIndex..., in: text)
		var links: [Link] = []
		/// The same span in the original string (the masked one only finds the links).
		func inSource(_ range: Range<String.Index>) -> Range<String.Index> {
			Range(NSRange(range, in: text), in: source) ?? source.startIndex..<source.startIndex
		}
		for m in pattern.matches(in: text, range: whole) {
			guard var range = Range(m.range, in: text) else { continue }
			func group(_ i: Int) -> String? {
				Range(m.range(at: i), in: text).map { String(text[$0]) }
			}
			if let href = group(3) {
				links.append(Link(range: inSource(range), href: href, isImage: group(1) == "!"))
			} else if let href = group(4) {
				links.append(Link(range: inSource(range), href: href, isImage: false))
			} else if var href = group(5) {
				// "(see https://…/objects/x)." — the closing bracket and full stop are the sentence's.
				while let last = href.unicodeScalars.last, trailing.contains(last) {
					href.removeLast()
					range = range.lowerBound..<text.index(before: range.upperBound)
				}
				links.append(Link(range: inSource(range), href: href, isImage: false))
			}
		}
		return links
	}
}

/// One piece of a message once its stand-alone links are lifted out.
public enum LinkedSegment: Equatable, Sendable {
	/// Markdown that stays as it is.
	case text(String)
	/// A paragraph or list item that is nothing but a link to `target`. `source` is the original
	/// markdown, which is what shows until (and unless) the target turns into a card.
	/// `label` is the short lead-in before the link ("Draft:"), kept as text when the card is drawn.
	case item(LinkedTarget, label: String?, source: String)
}

public enum LinkedMessageSplitter {
	/// A leading label such as "Draft:" or "Email to Torben:" may sit before a link on its own.
	static let maxLabelLength = 60

	private static let listItem = try! NSRegularExpression(pattern: #"^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$"#)
	private static let afterLink = try! NSRegularExpression(pattern: #"^[\s.,;:!?)\]]*$"#)

	/// The target of a paragraph or list item that consists of one link and nothing else, optionally
	/// after a short label ending in a colon (paragraphs only) and before closing punctuation. A
	/// link inside a sentence is not stand-alone.
	public static func standaloneTarget(of unit: String, allowLabel: Bool) -> LinkedTarget? {
		standalone(of: unit, allowLabel: allowLabel)?.target
	}

	static func standalone(of unit: String, allowLabel: Bool) -> (target: LinkedTarget, label: String?)? {
		let links = LinkScanner.links(in: unit)
		guard links.count == 1, let link = links.first, !link.isImage, let target = LinkedTarget.parse(href: link.href)
		else { return nil }
		let before = String(unit[..<link.range.lowerBound])
		let after = String(unit[link.range.upperBound...])
		// Code or a picture around the link makes it part of something else.
		if before.contains("`") || after.contains("`") || before.contains("![") { return nil }
		let emphasis = CharacterSet(charactersIn: "*_~")
		func bare(_ s: String) -> String { String(s.unicodeScalars.filter { !emphasis.contains($0) }) }
		let tail = bare(after)
		guard afterLink.firstMatch(in: tail, range: NSRange(tail.startIndex..., in: tail)) != nil else { return nil }
		let label = bare(before).trimmingCharacters(in: .whitespacesAndNewlines)
		if !label.isEmpty, !(allowLabel && label.count <= maxLabelLength && label.hasSuffix(":")) { return nil }
		let lead = String(unit[..<link.range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
		return (target, lead.isEmpty ? nil : lead)
	}

	/// Splits a message into ordered text and stand-alone linked items. Fenced code is never
	/// touched. Joining the segments' sources reproduces the message's content.
	public static func split(_ markdown: String) -> [LinkedSegment] {
		LinkScanCaches.segments.value(for: markdown) { scan(markdown) }
	}

	static func scan(_ markdown: String) -> [LinkedSegment] {
		let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
		var segments: [LinkedSegment] = []
		var buffer: [String] = []
		var paragraph: [String] = []
		var fence: Character?
		var previousWasList = false

		func flushText() {
			let text = buffer.joined(separator: "\n").trimmingCharacters(in: .newlines)
			buffer = []
			if !text.trimmingCharacters(in: .whitespaces).isEmpty { segments.append(.text(text)) }
		}
		func emit(_ target: LinkedTarget, label: String?, source: String) {
			flushText()
			segments.append(.item(target, label: label, source: source))
		}
		func flushParagraph() {
			guard !paragraph.isEmpty else { return }
			defer { paragraph = [] }
			let first = paragraph[0].trimmingCharacters(in: .whitespaces)
			let isDefinition = first.range(of: #"^\[[^\]]+\]:"#, options: .regularExpression) != nil
			let eligible =
				!(isDefinition || first.hasPrefix("#") || first.hasPrefix(">") || first.hasPrefix("|") || paragraph[0].hasPrefix("    ")
					|| paragraph[0].hasPrefix("\t"))
			let joined = paragraph.joined(separator: " ")
			if eligible, let found = standalone(of: joined, allowLabel: true) {
				emit(found.target, label: found.label, source: paragraph.joined(separator: "\n"))
			} else {
				buffer.append(contentsOf: paragraph)
			}
		}

		for line in lines {
			let trimmed = line.trimmingCharacters(in: .whitespaces)
			let marker = LinkScanner.fenceMarker(of: line)
			if fence == nil, marker != nil {
				flushParagraph()
				buffer.append(line)
				fence = marker
				previousWasList = false
				continue
			}
			if fence != nil {
				buffer.append(line)
				if marker == fence { fence = nil }
				continue
			}
			if trimmed.isEmpty {
				flushParagraph()
				buffer.append(line)
				continue
			}
			// Four spaces is code, unless it continues a list.
			let indented = line.hasPrefix("    ") || line.hasPrefix("\t")
			if !(indented && !previousWasList), let m = listItem.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
				let contentRange = Range(m.range(at: 1), in: line)
			{
				flushParagraph()
				previousWasList = true
				if let found = standalone(of: String(line[contentRange]), allowLabel: false) {
					emit(found.target, label: nil, source: line)
				} else {
					buffer.append(line)
				}
				continue
			}
			previousWasList = false
			paragraph.append(line)
		}
		flushParagraph()
		flushText()
		return segments
	}
}

/// What to draw for a message once it is known which of its links turn into cards.
public enum LinkedMessagePart: Equatable, Sendable {
	case markdown(String)
	case card(LinkedTarget)

	/// A key that survives a card above resolving: cards by their target, text by position.
	public func stableID(at index: Int) -> String {
		switch self {
		case .markdown: "text-\(index)"
		case .card(let target): "card-\(target.key)"
		}
	}
}

public enum LinkedMessageLayout {
	public static let maxAppendedPerKind = 3

	/// The message's body as markdown and in-place cards. A stand-alone link whose target is not (yet)
	/// a card stays in the text, so a link never vanishes; neighbouring text is merged back into one
	/// block so a message with no card reads exactly as it did before. A target is drawn once in
	/// place; its later stand-alone mentions stay links.
	public static func parts(
		segments: [LinkedSegment], isCard: (LinkedTarget) -> Bool
	) -> [LinkedMessagePart] {
		var parts: [LinkedMessagePart] = []
		var pending: [String] = []
		var placed = Set<String>()
		func flush() {
			guard !pending.isEmpty else { return }
			var text = pending[0]
			for next in pending.dropFirst() {
				// Neighbouring list items stay one tight list; anything else is a new block.
				text += isListLine(text.components(separatedBy: "\n").last ?? "")
					&& isListLine(next.components(separatedBy: "\n").first ?? "") ? "\n" : "\n\n"
				text += next
			}
			parts.append(.markdown(text))
			pending = []
		}
		for segment in segments {
			switch segment {
			case .text(let text):
				pending.append(text)
			case .item(let target, let label, let source):
				if isCard(target), placed.insert(target.key).inserted {
					// Only the link becomes the card; what led into it stays words.
					if let label { pending.append(label) }
					flush()
					parts.append(.card(target))
				} else {
					pending.append(source)
				}
			}
		}
		flush()
		return parts
	}

	private static let listLine = try! NSRegularExpression(pattern: #"^\s*(?:[-*+]|\d{1,9}[.)])\s+"#)

	private static func isListLine(_ line: String) -> Bool {
		listLine.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
	}

	/// The cards that go under the message: the targets linked inside a sentence (or beyond the ones
	/// drawn in place), up to three objects and three files, none of them drawn in place.
	public static func appended(
		message markdown: String, parts: [LinkedMessagePart], isCard: (LinkedTarget) -> Bool
	) -> [LinkedTarget] {
		let drawn = Set(
			parts.compactMap { part -> String? in
				if case .card(let target) = part { return target.key }
				return nil
			})
		let remaining = LinkedTarget.extract(from: markdown).filter { !drawn.contains($0.key) && isCard($0) }
		let objects = remaining.filter { $0.kind == .object }.prefix(maxAppendedPerKind)
		let files = remaining.filter { $0.kind == .file }.prefix(maxAppendedPerKind)
		return Array(objects) + Array(files)
	}
}

/// One thing a conversation links to, with the message that linked it last.
public struct LinkedEntry: Equatable, Sendable, Identifiable {
	public var target: LinkedTarget
	/// The newest message that links it (`ChatMessage.id`, the row id).
	public var messageID: String
	public var actorID: String
	public var actorName: String
	public var author: ChatParticipant.Kind
	public var date: Date?

	public var id: String { target.key }
}

public enum LinkedConversationItems {
	public static let defaultLimit = 100

	/// Every object and file the conversation's messages link to, newest linking message first, one
	/// entry per target (the newest message wins). `messages` run oldest first. A message of your own
	/// counts too: what you linked is part of the conversation.
	public static func derive(from messages: [ChatMessage], limit: Int = defaultLimit) -> [LinkedEntry] {
		var entries: [LinkedEntry] = []
		var seen = Set<String>()
		for message in messages.reversed() {
			guard entries.count < limit else { break }
			guard message.kind == "message", !message.isFailed,
				message.content.contains("/objects/") || message.content.contains("/files/")
			else { continue }
			let targets = LinkedTarget.extract(from: message.content)
			let objects = targets.filter { $0.kind == .object }
			let files = targets.filter { $0.kind == .file }
			for target in objects + files {
				guard entries.count < limit, seen.insert(target.key).inserted else { continue }
				entries.append(
					LinkedEntry(
						target: target, messageID: message.id, actorID: message.actorID, actorName: message.actorName,
						author: message.author, date: message.createdAt))
			}
		}
		return entries
	}
}

/// Results of the link scans, keyed by the text. A message row re-reads its links every time the
/// thread renders, and each read is several regex passes; the text of a message rarely changes, so
/// the answer is remembered (bounded, and dropped under memory pressure by `NSCache`).
final class LinkScanCache<Value: Sendable>: @unchecked Sendable {
	private final class Box { let value: Value; init(_ value: Value) { self.value = value } }
	private let cache = NSCache<NSString, Box>()
	private let counter = Counter()

	init(limit: Int = 500) { cache.countLimit = limit }

	/// How many times `compute` ran (tests pin that a repeat read does not).
	var computeCount: Int { counter.value }

	func value(for text: String, compute: () -> Value) -> Value {
		let key = text as NSString
		if let hit = cache.object(forKey: key) { return hit.value }
		let value = compute()
		counter.increment()
		cache.setObject(Box(value), forKey: key)
		return value
	}

	private final class Counter: @unchecked Sendable {
		private let lock = NSLock()
		private var count = 0
		var value: Int { lock.lock(); defer { lock.unlock() }; return count }
		func increment() { lock.lock(); count += 1; lock.unlock() }
	}
}

enum LinkScanCaches {
	static let targets = LinkScanCache<[LinkedTarget]>()
	static let segments = LinkScanCache<[LinkedSegment]>()
}
