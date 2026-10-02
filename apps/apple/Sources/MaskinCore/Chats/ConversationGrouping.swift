import Foundation

/// A labelled bucket of the Chats list.
public struct ConversationGroup: Identifiable, Equatable, Sendable {
	public enum Key: String, Sendable { case pinned, today, yesterday, week, earlier, results }
	public var key: Key
	public var label: String
	public var items: [ConversationSummary]
	public var id: Key { key }
}

public enum ConversationGrouping {
	/// Pinned first, then Today / Yesterday / This week / Earlier by `lastMessageAt ?? createdAt`
	/// (the web's `groupConversations`). Empty buckets are dropped; rows with no usable date go to
	/// Earlier rather than vanishing. Within a bucket, most recent first.
	public static func group(
		_ conversations: [ConversationSummary], now: Date = Date(), calendar: Calendar = .current
	) -> [ConversationGroup] {
		var buckets: [ConversationGroup.Key: [ConversationSummary]] = [:]
		let today = calendar.startOfDay(for: now)
		for c in conversations {
			if c.pinned {
				buckets[.pinned, default: []].append(c)
				continue
			}
			guard let date = c.activityDate else {
				buckets[.earlier, default: []].append(c)
				continue
			}
			let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: today).day ?? 0
			let key: ConversationGroup.Key =
				days <= 0 ? .today : days == 1 ? .yesterday : days <= 7 ? .week : .earlier
			buckets[key, default: []].append(c)
		}
		let order: [(ConversationGroup.Key, String)] = [
			(.pinned, "Pinned"), (.today, "Today"), (.yesterday, "Yesterday"), (.week, "This week"),
			(.earlier, "Earlier"),
		]
		return order.compactMap { key, label in
			guard let items = buckets[key], !items.isEmpty else { return nil }
			return ConversationGroup(
				key: key, label: label,
				items: items.sorted {
					($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast)
				})
		}
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
