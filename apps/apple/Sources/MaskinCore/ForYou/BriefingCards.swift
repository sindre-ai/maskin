import Foundation

/// One card in the For you briefing row. Today there is the daily briefing; later cards (per-flow
/// executive briefings, HTML presentations) are more `Format` cases, not a new row.
public struct BriefingCard: Identifiable, Sendable, Equatable {
	public enum Format: Sendable, Equatable {
		/// Formatted text, opened in the reader.
		case text(markdown: String)
	}

	public var id: String
	/// The small glass label on the card: "DAILY", or a flow's name.
	public var unit: String
	public var title: String
	public var format: Format

	public init(id: String, unit: String, title: String, format: Format) {
		self.id = id
		self.unit = unit
		self.title = title
		self.format = format
	}

	/// "READ · 1 MIN", "DECK · 4 CARDS".
	public var formatLabel: String {
		switch format {
		case .text(let markdown):
			return "READ · \(BriefingCards.readMinutes(markdown)) MIN"
		}
	}
}

public enum BriefingCards {
	/// Cards for the row: the daily briefing first, once it has loaded and has something to say.
	public static func cards(
		brief: BriefState, firstName: String?, now: Date = Date(), calendar: Calendar = .current
	) -> [BriefingCard] {
		guard case .loaded(let loaded) = brief else { return [] }
		let body = loaded.markdown.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !body.isEmpty else { return [] }
		return [
			BriefingCard(
				id: "daily-\(dayKey(now, calendar: calendar))", unit: "DAILY",
				title: greeting(firstName: firstName, now: now, calendar: calendar),
				format: .text(markdown: body))
		]
	}

	public static func greeting(firstName: String?, now: Date, calendar: Calendar = .current) -> String {
		let hour = calendar.component(.hour, from: now)
		let part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
		let name = firstName?.split(separator: " ").first.map(String.init)
		return name.map { "\(part), \($0)" } ?? part
	}

	/// Whole minutes to read at 200 words a minute, never less than one.
	public static func readMinutes(_ markdown: String) -> Int {
		let words = markdown.split(whereSeparator: \.isWhitespace).count
		return max(1, Int((Double(words) / 200).rounded(.up)))
	}

	static func dayKey(_ date: Date, calendar: Calendar) -> String {
		let c = calendar.dateComponents([.year, .month, .day], from: date)
		return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
	}
}

/// Which briefing cards the reader has opened, so the row can show new ones differently. Per
/// device: a briefing is "seen" once, and a new day's card has a new id.
public struct BriefingSeen: Sendable {
	private let defaults: UserDefaultsBox
	private let key: String

	public init(defaults: UserDefaults = .standard, key: String = "foryou.briefing.seen.v1") {
		self.defaults = UserDefaultsBox(defaults)
		self.key = key
	}

	public func isSeen(_ id: String) -> Bool { ids().contains(id) }

	public func markSeen(_ id: String) {
		var all = ids()
		all.insert(id)
		// A week of days is plenty; keep the list from growing without bound.
		defaults.value.set(Array(all.sorted().suffix(60)), forKey: key)
	}

	private func ids() -> Set<String> {
		Set(defaults.value.stringArray(forKey: key) ?? [])
	}
}

/// `UserDefaults` is thread-safe but not `Sendable` on every SDK.
private struct UserDefaultsBox: @unchecked Sendable {
	let value: UserDefaults
	init(_ value: UserDefaults) { self.value = value }
}
