import Foundation

/// One card of a presentation, derived from the HTML page a flow produced (a presentation is just
/// an HTML file linked to a flow). Pure and defensive: HTML is untrusted and free-form, so this
/// reads only visible text and a few structural hints, and never runs or loads anything.
public struct PresentationSlide: Equatable, Sendable, Identifiable {
	public struct Bar: Equatable, Sendable {
		public var label: String
		/// 0...1
		public var fraction: Double
	}

	public enum Kind: Equatable, Sendable {
		/// Plain text.
		case text
		/// A headline figure drawn large above the text.
		case stat(big: String)
		/// Labelled percentages drawn as bars.
		case bars([Bar])
		/// The closing card: what the page asks the reader to do (a link or button), if it names one.
		case cta(action: String?)
	}

	public var id: Int
	public var kind: Kind
	public var text: String
}

public enum PresentationParser {
	public static let maxSlides = 8
	public static let maxWords = 25
	/// Seconds a card stays up when the presentation plays itself.
	public static let secondsPerCard: TimeInterval = 10

	public static func parse(html: String) -> [PresentationSlide] {
		let cleaned = html
			.replacingOccurrences(of: "(?is)<(script|style|head)\\b.*?</\\1\\s*>", with: " ", options: .regularExpression)
		let blocks = split(cleaned)
		var slides: [PresentationSlide] = []
		for block in blocks {
			guard slides.count < maxSlides else { break }
			let text = plain(block)
			guard !text.isEmpty else { continue }
			slides.append(PresentationSlide(id: slides.count, kind: kind(of: block, text: text), text: clamp(text)))
		}
		// Only the last card can close the presentation, and only if the page gave it an action.
		if let last = slides.indices.last {
			if let action = action(in: blocks.last(where: { !plain($0).isEmpty }) ?? "") {
				slides[last].kind = .cta(action: action)
			}
		}
		return slides
	}

	public static func duration(of slides: [PresentationSlide]) -> TimeInterval {
		Double(slides.count) * secondsPerCard
	}

	/// How many cards the page holds before the `maxSlides` cap, so a trimmed deck can say so.
	public static func totalCount(html: String) -> Int {
		let cleaned = html
			.replacingOccurrences(of: "(?is)<(script|style|head)\\b.*?</\\1\\s*>", with: " ", options: .regularExpression)
		return split(cleaned).filter { !plain($0).isEmpty }.count
	}

	/// "4 cards · 0:40", or "8 of 18 cards · 1:20" when the page holds more than the cap keeps.
	public static func summary(of slides: [PresentationSlide], total: Int? = nil) -> String {
		let seconds = Int(duration(of: slides))
		let cards: String
		if let total, total > slides.count {
			cards = "\(slides.count) of \(total) cards"
		} else {
			cards = slides.count == 1 ? "1 card" : "\(slides.count) cards"
		}
		return "\(cards) \u{00B7} \(seconds / 60):" + String(format: "%02d", seconds % 60)
	}

	// MARK: Reading

	private static func split(_ html: String) -> [String] {
		if let sections = matches(#"(?is)<section\b[^>]*>(.*?)</section\s*>"#, in: html), sections.count > 1 {
			return sections
		}
		// One card per top-level heading.
		let marked = html.replacingOccurrences(
			of: #"(?i)<h[12]\b"#, with: "\u{1}<h1", options: .regularExpression)
		let parts = marked.components(separatedBy: "\u{1}").filter { !plain($0).isEmpty }
		return parts.isEmpty ? [html] : parts
	}

	private static func matches(_ pattern: String, in text: String) -> [String]? {
		guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
		let range = NSRange(text.startIndex..., in: text)
		let found = regex.matches(in: text, range: range).compactMap { match -> String? in
			guard match.numberOfRanges > 1, let r = Range(match.range(at: 1), in: text) else { return nil }
			return String(text[r])
		}
		return found
	}

	static func plain(_ html: String) -> String {
		var text = html.replacingOccurrences(of: "(?i)</(p|div|li|tr|h[1-6]|section)>|<br\\s*/?>", with: "\n", options: .regularExpression)
		text = text.replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
		text = HTMLEntities.decode(text)
		return text.components(separatedBy: "\n")
			.map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
			.filter { !$0.isEmpty }.joined(separator: "\n")
	}

	private static func kind(of block: String, text: String) -> PresentationSlide.Kind {
		let bars = self.bars(in: text)
		if bars.count >= 2 { return .bars(bars) }
		if let big = headlineFigure(in: block, text: text) { return .stat(big: big) }
		return .text
	}

	/// Lines that end in a percentage: "Replies 18%", "Open rate: 42 %".
	private static func bars(in text: String) -> [PresentationSlide.Bar] {
		text.components(separatedBy: "\n").compactMap { line in
			guard let m = line.range(of: #"(\d{1,3}(?:\.\d+)?)\s*%\s*$"#, options: .regularExpression) else { return nil }
			let figure = line[m].replacingOccurrences(of: "%", with: "").trimmingCharacters(in: .whitespaces)
			guard let value = Double(figure), value <= 100 else { return nil }
			let label = line[..<m.lowerBound].trimmingCharacters(in: CharacterSet(charactersIn: " :-\u{2013}\u{2014}\t"))
			return label.isEmpty ? nil : PresentationSlide.Bar(label: label, fraction: value / 100)
		}
	}

	/// An element the author marked as the big number (class stat, big, kpi, metric), else a card
	/// whose text opens on a figure.
	private static func headlineFigure(in block: String, text: String) -> String? {
		if let marked = matches(#"(?is)<[^>]+class="[^"]*\b(?:stat|big|kpi|metric)\b[^"]*"[^>]*>([^<]{1,12})<"#, in: block)?.first {
			let value = marked.trimmingCharacters(in: .whitespacesAndNewlines)
			if !value.isEmpty { return value }
		}
		guard let first = text.components(separatedBy: "\n").first,
			let m = first.range(of: #"^[$€£]?\d[\d.,]{0,5}[%kKmM]?(?=\s)"#, options: .regularExpression)
		else { return nil }
		let rest = first[m.upperBound...].trimmingCharacters(in: .whitespaces)
		return rest.isEmpty ? nil : String(first[m])
	}

	private static func action(in block: String) -> String? {
		for pattern in [#"(?is)<a\b[^>]*>(.*?)</a\s*>"#, #"(?is)<button\b[^>]*>(.*?)</button\s*>"#] {
			if let found = matches(pattern, in: block)?.map(plain).first(where: { !$0.isEmpty }) {
				return String(found.prefix(40))
			}
		}
		return nil
	}

	private static func clamp(_ text: String) -> String {
		let words = text.split(whereSeparator: { $0 == " " })
		guard words.count > maxWords else { return text }
		return words.prefix(maxWords).joined(separator: " ") + "\u{2026}"
	}
}
