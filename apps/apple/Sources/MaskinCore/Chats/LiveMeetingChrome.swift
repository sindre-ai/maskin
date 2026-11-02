import Foundation

/// Where a live call began: inside a thread that already existed, or from nothing, in which case
/// the call made its own thread.
public enum LiveCallOrigin: Equatable, Sendable {
	case thread, ownThread
}

/// One edge of a live call as the thread draws it: `LIVE MEETING · STARTED 14:02`.
public struct LiveCallDivider: Equatable, Sendable, Identifiable {
	public enum Edge: String, Sendable { case started, ended }

	public var key: String
	public var edge: Edge
	public var at: Date
	public var calendar: Calendar

	public var id: String { "call-\(edge.rawValue)-\(key)" }
	public var label: String { LiveMeetingChrome.dividerLabel(edge, at: at, calendar: calendar) }
}

/// A call's start and (once it is over) end, worked out from what the thread holds.
public struct LiveCallSpan: Equatable, Sendable {
	public var key: String
	public var startedAt: Date
	public var endedAt: Date?
}

/// Wording for the call's header and the thread's call dividers, kept apart from the views.
public enum LiveMeetingChrome {
	/// The title of a thread the call made for itself.
	public static let ownThreadTitle = "Live meeting"

	/// The line under the header title while a call runs. A call from a thread says what thread it
	/// is in ("Developer · live"); a call that made its own thread says who and when
	/// ("Chief of Staff · Tue 14:02").
	public static func subline(
		origin: LiveCallOrigin, threadTitle: String, leadName: String, startedAt: Date,
		calendar: Calendar = .current
	) -> String {
		switch origin {
		case .thread: "\(threadTitle) · live"
		case .ownThread: "\(leadName) · \(format("EEE HH:mm", startedAt, calendar))"
		}
	}

	/// "LIVE MEETING · STARTED 14:02", 24-hour local time.
	public static func dividerLabel(_ edge: LiveCallDivider.Edge, at date: Date, calendar: Calendar = .current) -> String {
		"LIVE MEETING · \(edge.rawValue.uppercased()) \(format("HH:mm", date, calendar))"
	}

	private static func format(_ pattern: String, _ date: Date, _ calendar: Calendar) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.calendar = calendar
		formatter.timeZone = calendar.timeZone
		formatter.dateFormat = pattern
		return formatter.string(from: date)
	}

	/// The server keeps a silent call open this long before it ends it.
	static let idleTimeout: TimeInterval = 15 * 60

	/// Every call the thread can tell about. The server's spoken lines (`metadata.voice_session_id`)
	/// give a call's span on any device; this device's own records give exact times and cover
	/// calls that said nothing the server kept (a dictated call, a transcript-free workspace).
	public static func spans(
		messages: [ChatMessage], records: [LiveCallRecord], now: Date
	) -> [LiveCallSpan] {
		var groups: [String: (start: Date, end: Date)] = [:]
		for message in messages where message.isVoiceTranscript {
			guard let id = message.metadata?["voice_session_id"]?.stringValue, let at = message.createdAt else { continue }
			if let known = groups[id] {
				groups[id] = (min(known.start, at), max(known.end, at))
			} else {
				groups[id] = (at, at)
			}
		}
		var spans: [LiveCallSpan] = []
		for record in records.sorted(by: { $0.startedAt < $1.startedAt }) {
			spans.append(LiveCallSpan(key: record.id, startedAt: record.startedAt, endedAt: record.endedAt))
			let window = record.startedAt.addingTimeInterval(-LiveCallWindow.skew)...(record.endedAt.map { $0.addingTimeInterval(LiveCallWindow.grace) } ?? .distantFuture)
			for (id, group) in groups where window.contains(group.start) { groups[id] = nil }
		}
		for (id, group) in groups {
			let over = now.timeIntervalSince(group.end) > idleTimeout
			spans.append(LiveCallSpan(key: id, startedAt: group.start, endedAt: over ? group.end : nil))
		}
		return spans.sorted { $0.startedAt < $1.startedAt }
	}

	/// Puts each call's start and end dividers into `items`: the start before the first row at or
	/// after the call began, the end after the last row from the call (its closing replies included).
	static func insertDividers(_ spans: [LiveCallSpan], into items: inout [ThreadItem], calendar: Calendar) {
		for span in spans {
			let start = LiveCallDivider(key: span.key, edge: .started, at: span.startedAt, calendar: calendar)
			let from = span.startedAt.addingTimeInterval(-LiveCallWindow.skew)
			let startIndex = items.firstIndex { ($0.anchorTime ?? .distantPast) >= from } ?? items.count
			items.insert(.callDivider(start), at: startIndex)
			guard let endedAt = span.endedAt else { continue }
			let limit = endedAt.addingTimeInterval(LiveCallWindow.grace)
			let last = items.indices.last { $0 > startIndex && (items[$0].time.map { $0 <= limit } ?? false) }
			let end = LiveCallDivider(key: span.key, edge: .ended, at: endedAt, calendar: calendar)
			items.insert(.callDivider(end), at: (last ?? startIndex) + 1)
		}
	}
}

extension ThreadItem {
	/// When the row happened, for placing a call's dividers among rows. Rows with no time have none.
	var time: Date? {
		switch self {
		case .message(let m, _), .system(let m): m.createdAt
		case .liveCall(let card): card.record.startedAt
		case .callDivider(let divider): divider.at
		case .receipt(let event): event.at
		case .daySeparator, .unreadDivider, .handoff, .callSummary: nil
		}
	}

	/// Where the call's start divider may go: like `time`, but a call's summary card counts as
	/// starting where its call did, so the divider lands before it. It stays out of `time` so the
	/// end divider goes before the summary, not after it.
	var anchorTime: Date? {
		if case .callSummary(let summary, _) = self { return summary.startedAt }
		return time
	}
}
