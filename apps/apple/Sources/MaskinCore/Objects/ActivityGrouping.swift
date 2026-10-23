import Foundation

/// How one activity item is drawn (handoff `specs/8-Objects.md` → Activity grouping).
public enum ActivityKind: Sendable, Equatable {
	/// Authored text long enough to read as a message: avatar, name and a card bubble.
	case comment
	/// Everything else: one quiet line, "**who** what · time".
	case event
}

/// One item of the activity page with the things the view needs decided for it.
public struct ActivityEntry: Identifiable, Equatable, Sendable {
	public var item: TimelineItem
	public var kind: ActivityKind
	/// A clock time, only when the item happened today. Older days read by their heading.
	public var timeLabel: String?
	/// Items threaded under this one (`parentEventId`), oldest first, the way a thread reads.
	public var replies: [ActivityEntry]

	public var id: String { item.id }

	public init(item: TimelineItem, kind: ActivityKind, timeLabel: String? = nil, replies: [ActivityEntry] = []) {
		self.item = item
		self.kind = kind
		self.timeLabel = timeLabel
		self.replies = replies
	}
}

/// The activity of one local day, newest day first on the page.
public struct ActivityDay: Identifiable, Equatable, Sendable {
	public var id: String
	/// "Today", "Yesterday", "Mon", "6 Oct".
	public var label: String
	public var entries: [ActivityEntry]

	public init(id: String, label: String, entries: [ActivityEntry]) {
		self.id = id
		self.label = label
		self.entries = entries
	}
}

/// Groups an object's activity by local day and decides what is a comment and what is an event.
/// Replies nest under their thread's top-level message (a reply to a reply joins the same thread)
/// instead of appearing where their own date would put them.
public enum ActivityGrouping {
	/// Authored text past this many characters is a comment; at or under it, a quiet line.
	public static let commentThreshold = 110
	/// A day heading says the weekday name for this many days back, then a date.
	public static let weekdayWindowDays = 6

	/// Newest day first, newest item first within a day. Items whose parent is on the page nest
	/// under it (oldest reply first); items without a date join the newest day.
	public static func days(
		_ items: [TimelineItem], now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
	) -> [ActivityDay] {
		let byEventId = Dictionary(items.compactMap { item in item.eventId.map { ($0, item) } }, uniquingKeysWith: { a, _ in a })
		/// A thread is one level deep: a reply to a reply joins the top-level message it hangs from.
		func threadRoot(of item: TimelineItem) -> TimelineItem? {
			var current = item
			var seen: Set<String> = [item.id]
			while let parent = current.parentEventId, let next = byEventId[parent], seen.insert(next.id).inserted {
				current = next
			}
			return current.id == item.id ? nil : current
		}
		var replies: [String: [TimelineItem]] = [:]
		var roots: [TimelineItem] = []
		for item in items {
			if let root = threadRoot(of: item) {
				replies[root.id, default: []].append(item)
			} else {
				roots.append(item)
			}
		}
		for key in replies.keys {
			replies[key]?.sort { Self.sortKey($0) < Self.sortKey($1) }
		}
		// Dated items first (newest first); undated ones then join the newest day.
		let ordered = roots.sorted { Self.sortKey($0) > Self.sortKey($1) }
			.sorted { ($0.date == nil ? 1 : 0) < ($1.date == nil ? 1 : 0) }

		var out: [ActivityDay] = []
		for item in ordered {
			let entry = ActivityEntry(
				item: item, kind: kind(of: item), timeLabel: timeLabel(item.date, now: now, calendar: calendar, locale: locale),
				replies: (replies[item.id] ?? []).map {
					ActivityEntry(item: $0, kind: kind(of: $0), timeLabel: timeLabel($0.date, now: now, calendar: calendar, locale: locale))
				})
			guard let date = item.date else {
				// Undated (never for stored events): ride with the newest day rather than invent one.
				if out.isEmpty {
					out.append(ActivityDay(id: "undated", label: dayLabel(now, now: now, calendar: calendar, locale: locale), entries: [entry]))
				} else {
					out[0].entries.append(entry)
				}
				continue
			}
			let day = calendar.startOfDay(for: date)
			let id = "\(Int(day.timeIntervalSince1970))"
			if let index = out.firstIndex(where: { $0.id == id }) {
				out[index].entries.append(entry)
			} else {
				out.append(ActivityDay(id: id, label: dayLabel(day, now: now, calendar: calendar, locale: locale), entries: [entry]))
			}
		}
		return out
	}

	/// Every authored comment is a message, however short. System events are one-line events.
	public static func kind(of item: TimelineItem) -> ActivityKind {
		if case .comment = item.kind { return .comment }
		return .event
	}

	/// What the quiet line (and the Latest row) says after the name: the system summary, or the
	/// remark itself on one line.
	public static func summary(of item: TimelineItem) -> String {
		switch item.kind {
		case .activity(let summary): return summary
		case .comment(let text):
			let flat = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
				.filter { !$0.isEmpty }.joined(separator: " ")
			return flat.isEmpty ? "commented" : flat
		}
	}

	/// "Today", "Yesterday", the weekday name within `weekdayWindowDays`, otherwise "6 Oct"
	/// (with the year once it is not this year).
	public static func dayLabel(
		_ day: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
	) -> String {
		if calendar.isDate(day, inSameDayAs: now) { return "Today" }
		if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) {
			return "Yesterday"
		}
		let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: day), to: calendar.startOfDay(for: now)).day ?? 0
		if days > 0, days <= weekdayWindowDays {
			return format(day, template: "EEE", calendar: calendar, locale: locale)
		}
		let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
		return format(day, template: sameYear ? "d MMM" : "d MMM yyyy", calendar: calendar, locale: locale)
	}

	/// The clock time for something that happened today; nil for any other day or no date.
	public static func timeLabel(
		_ date: Date?, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
	) -> String? {
		guard let date, calendar.isDate(date, inSameDayAs: now) else { return nil }
		return format(date, template: "jmm", calendar: calendar, locale: locale)
	}

	private static func sortKey(_ item: TimelineItem) -> (Date, Int) {
		(item.date ?? .distantFuture, item.eventId ?? Int.max)
	}

	private static func format(_ date: Date, template: String, calendar: Calendar, locale: Locale) -> String {
		let f = DateFormatter()
		f.calendar = calendar
		f.timeZone = calendar.timeZone
		f.locale = locale
		f.setLocalizedDateFormatFromTemplate(template)
		return f.string(from: date)
	}
}

/// When an object's description folds and what the fold button says
/// (`specs/8-Objects.md`: above ~520 characters it collapses, "Read all · N min").
public enum DescriptionCollapse {
	public static let characterThreshold = 520
	public static let wordsPerMinute = 200

	public static func collapses(_ text: String) -> Bool {
		text.trimmingCharacters(in: .whitespacesAndNewlines).count > characterThreshold
	}

	/// Whole minutes at a reading pace, never under one.
	public static func readingMinutes(_ text: String) -> Int {
		let words = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
		return max(1, Int((Double(words) / Double(wordsPerMinute)).rounded(.up)))
	}

	public static func readAllLabel(_ text: String) -> String {
		"Read all · \(readingMinutes(text)) min"
	}
}
