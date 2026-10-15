import Foundation
import MaskinCore

// Pure logic behind the Apple TV briefing player and the Flows header. Same placement as
// `TVLogic.swift`: no UI imports, so `swift test` covers it on the Mac.

/// What one screen of the briefing player shows (6-TV.md, "Briefing player").
public enum TVSlideKind: Equatable, Sendable {
	/// Plain text, large.
	case text
	/// A leading figure drawn as a huge numeral above the rest of the sentence.
	case stat(big: String, rest: String)
	/// The last slide: it stops auto-advancing and offers an action.
	case cta
}

public enum TVSlideClassifier {
	/// The figure a sentence opens with ("7 follow-ups are ready", "18% more replies"), split from
	/// the rest of the sentence. nil when the sentence does not open with a number, or the number
	/// is all there is. Only the script's own words are used, nothing is invented.
	public static func stat(in text: String) -> (big: String, rest: String)? {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let match = trimmed.range(of: #"^[$€£]?\d[\d.,]{0,5}[%kKmM]?(?=\s)"#, options: .regularExpression)
		else { return nil }
		let big = String(trimmed[match])
		let rest = trimmed[match.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
		// A figure that closes a sentence ("Version 2. ...") or is a year is not a headline number.
		guard !rest.isEmpty, big.last != ".", big.last != "," else { return nil }
		if big.count == 4, Int(big).map({ (1900...2100).contains($0) }) == true { return nil }
		return (big, rest)
	}

	/// One kind per slide. The last is the call to action; any other opening on a figure is a stat.
	public static func kinds(for texts: [String]) -> [TVSlideKind] {
		texts.enumerated().map { index, text in
			if index == texts.count - 1 { return .cta }
			if let found = stat(in: text) { return .stat(big: found.big, rest: found.rest) }
			return .text
		}
	}

	/// Point size for a slide's text: 72 for a line, smaller as the sentence grows so a whole slide
	/// stays on the 1080 pt screen.
	public static func textSize(for text: String) -> CGFloat {
		switch text.count {
		case ..<80: 72
		case ..<150: 60
		default: 52
		}
	}
}

/// The primary action on a briefing's last slide ("Review Northwind", "Open Outreach flow").
public struct TVBriefingAction: Equatable, Sendable {
	public enum Target: Equatable, Sendable {
		case decision(String)
		case flow(String)
	}

	public var title: String
	public var target: Target

	public init(title: String, target: Target) {
		self.title = title
		self.target = target
	}
}

public enum TVFlowsHeader {
	/// The line under the Flows title, from the loaded flows: "4 flows · 2 need you".
	public static func subtitle(for flows: [LoopSummary]) -> String? {
		guard !flows.isEmpty else { return nil }
		let count = flows.count == 1 ? "1 flow" : "\(flows.count) flows"
		let waiting = flows.filter { $0.waitingCount > 0 }.count
		switch waiting {
		case 0: return "\(count) · nothing needs you"
		case 1: return "\(count) · 1 needs you"
		default: return "\(count) · \(waiting) need you"
		}
	}
}
