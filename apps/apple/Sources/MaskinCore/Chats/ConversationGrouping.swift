import Foundation

/// A labelled bucket of the Chats list.
public struct ConversationGroup: Identifiable, Equatable, Sendable {
	/// Stable bucket identity. Day, week and month buckets are minted per date, so this is an
	/// open string rather than a closed enum.
	public struct Key: Hashable, Sendable, RawRepresentable {
		public var rawValue: String
		public init(rawValue: String) { self.rawValue = rawValue }
		public static let pinned = Key(rawValue: "pinned")
		public static let today = Key(rawValue: "today")
		public static let yesterday = Key(rawValue: "yesterday")
		public static let thisWeek = Key(rawValue: "thisWeek")
		public static let lastWeek = Key(rawValue: "lastWeek")
		public static let earlier = Key(rawValue: "earlier")
		public static let results = Key(rawValue: "results")
	}
	public var key: Key
	public var label: String
	public var items: [ConversationSummary]
	public var id: Key { key }
}

public enum ConversationGrouping {
	/// Pinned first, then by recency of `lastMessageAt ?? createdAt`: Today, Yesterday,
	/// This week (the days before that), Last week, then one
	/// bucket per month (with the year once it isn't the current one). Rows with no usable date
	/// go to Earlier rather than vanishing. Empty buckets never exist; within one, most recent
	/// first.
	public static func group(
		_ conversations: [ConversationSummary], now: Date = Date(), calendar: Calendar = .current
	) -> [ConversationGroup] {
		let today = calendar.startOfDay(for: now)
		var groups: [ConversationGroup] = []
		func append(_ c: ConversationSummary, key: ConversationGroup.Key, label: String) {
			if let last = groups.indices.last, groups[last].key == key {
				groups[last].items.append(c)
			} else {
				groups.append(ConversationGroup(key: key, label: label, items: [c]))
			}
		}
		let dated = conversations.filter { !$0.pinned && $0.activityDate != nil }
			.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
		let pinned = conversations.filter(\.pinned)
			.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
		for c in pinned { append(c, key: .pinned, label: "Pinned") }
		for c in dated {
			guard let date = c.activityDate else { continue }
			let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: today).day ?? 0
			switch days {
			case ...0: append(c, key: .today, label: "Today")
			case 1: append(c, key: .yesterday, label: "Yesterday")
			case 2...6: append(c, key: .thisWeek, label: "This week")
			case 7...13: append(c, key: .lastWeek, label: "Last week")
			default:
				let parts = calendar.dateComponents([.year, .month], from: date)
				let sameYear = parts.year == calendar.component(.year, from: now)
				let month = calendar.monthSymbols[(parts.month ?? 1) - 1]
				append(
					c, key: .init(rawValue: "month-\(parts.year ?? 0)-\(parts.month ?? 0)"),
					label: sameYear ? month : "\(month) \(parts.year ?? 0)")
			}
		}
		let undated = conversations.filter { !$0.pinned && $0.activityDate == nil }
		if !undated.isEmpty {
			groups.append(ConversationGroup(key: .earlier, label: "Earlier", items: undated))
		}
		return groups
	}

	/// Conversations an actor takes part in; nil keeps everything.
	public static func filter(_ conversations: [ConversationSummary], agentID: String?)
		-> [ConversationSummary]
	{
		guard let agentID else { return conversations }
		return conversations.filter { $0.participants.contains { $0.id == agentID } }
	}

	/// Case-insensitive match on title, snippet and participant names.
	public static func filter(_ conversations: [ConversationSummary], query: String)
		-> [ConversationSummary]
	{
		let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !q.isEmpty else { return conversations }
		return conversations.filter { c in
			c.title.localizedCaseInsensitiveContains(q)
				|| (c.snippet?.localizedCaseInsensitiveContains(q) ?? false)
				|| c.participants.contains { $0.name.localizedCaseInsensitiveContains(q) }
		}
	}
}
