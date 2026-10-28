import Foundation

/// What the thread renders, top to bottom: day separators, system dividers and messages, with
/// consecutive messages from one author collapsed under a single header.
public enum ThreadItem: Identifiable, Equatable, Sendable {
	case daySeparator(Date)
	case system(ChatMessage)
	case message(ChatMessage, showsAuthor: Bool)
	/// "N new", above the first message the reader hadn't seen when they opened the thread.
	case unreadDivider(count: Int)
	/// A sub-agent session the message above handed work to. `behind` names the sessions of the
	/// same message it waits on (a name, never an id).
	case handoff(SpawnedSession, behind: [String])
	/// A live call: one card holding every line of the call, which the thread does not also show as bubbles.
	case liveCall(LiveCallCard)

	public var id: String {
		switch self {
		case .unreadDivider: "unread-divider"
		case .daySeparator(let day): "day-\(Int(day.timeIntervalSince1970))"
		case .system(let m): m.id
		case .message(let m, _): m.id
		case .handoff(let session, _): "handoff-\(session.id)"
		case .liveCall(let card): card.id
		}
	}
}

/// One day of the thread: its date (for the header that stays pinned while the day scrolls by) and
/// everything under it. Items before the first dated message (a thread of undated rows) form a
/// section with no day.
public struct ThreadSection: Identifiable, Equatable, Sendable {
	public var day: Date?
	public var items: [ThreadItem]
	public var id: String { day.map { "day-\(Int($0.timeIntervalSince1970))" } ?? "undated" }
}

public enum ThreadLayout {
	/// Groups `items` by the day separators in them. A separator is not repeated inside its section:
	/// the section's `day` is what the header shows.
	public static func sections(for items: [ThreadItem]) -> [ThreadSection] {
		var sections: [ThreadSection] = []
		for item in items {
			if case .daySeparator(let day) = item {
				sections.append(ThreadSection(day: day, items: []))
			} else if sections.isEmpty {
				sections.append(ThreadSection(day: nil, items: [item]))
			} else {
				sections[sections.count - 1].items.append(item)
			}
		}
		return sections
	}

	/// A run of one author's messages breaks after this long a pause.
	public static let runGap: TimeInterval = 5 * 60

	/// - Parameters:
	///   - unreadAfter: the read cursor when the thread opened; with `currentActorID`, picks where
	///     the "new" divider goes (nil: no divider, e.g. a thread that was never read).
	public static func items(
		for messages: [ChatMessage], unreadAfter cursor: Int? = nil, currentActorID: String? = nil,
		calls: [LiveCallRecord] = [], calendar: Calendar = .current
	) -> [ThreadItem] {
		var items: [ThreadItem] = []
		// Each message belongs to at most one call; the card sits where the call's first message was.
		var callOf: [String: Int] = [:]
		var members: [[ChatMessage]] = Array(repeating: [], count: calls.count)
		for message in messages where !message.isSystem {
			if let index = calls.firstIndex(where: {
				LiveCallWindow.contains($0, message, currentActorID: currentActorID)
			}) {
				callOf[message.id] = index
				members[index].append(message)
			}
		}
		var emitted: Set<Int> = []
		func card(_ index: Int) -> ThreadItem {
			.liveCall(LiveCallCard(record: calls[index], messages: members[index], currentActorID: currentActorID))
		}
		var lastDay: Date?
		var previous: ChatMessage?
		// The first message from someone else past the cursor, and how many such there are.
		// Answering a message means having read everything before it, so the reader's own latest
		// message counts as read state too (the server cursor can lag: they replied elsewhere).
		var lastOwn = 0
		if let me = currentActorID {
			lastOwn = messages.last { $0.actorID == me && !$0.isSystem && $0.serverID != nil }?.serverID ?? 0
		}
		let unread: [ChatMessage] = cursor.map { (cursor: Int) -> [ChatMessage] in
			let cursor = max(cursor, lastOwn)
			return messages.filter {
				!$0.isSystem && ($0.serverID ?? 0) > cursor && ($0.serverID != nil) && $0.actorID != currentActorID
			}
		} ?? []
		let dividerBefore = unread.first?.id
		for message in messages {
			var folded = false
			if let index = callOf[message.id] {
				if emitted.contains(index) { continue }
				folded = true
			}
			// A call nobody spoke in has no message to sit at: it goes where it started.
			for index in calls.indices where members[index].isEmpty && !emitted.contains(index) {
				if calls[index].showsCard, let at = message.createdAt, calls[index].startedAt <= at {
					items.append(card(index))
					emitted.insert(index)
					previous = nil
				}
			}
			let day = message.createdAt.map { calendar.startOfDay(for: $0) }
			if let day, day != lastDay {
				items.append(.daySeparator(day))
				lastDay = day
				previous = nil
			}
			if folded, let index = callOf[message.id] {
				items.append(card(index))
				emitted.insert(index)
				previous = nil
				continue
			}
			if message.isSystem {
				items.append(.system(message))
				previous = nil
				continue
			}
			if message.id == dividerBefore {
				items.append(.unreadDivider(count: unread.count))
				previous = nil
			}
			var showsAuthor = true
			if let previous, previous.actorID == message.actorID,
				let a = previous.createdAt, let b = message.createdAt, b.timeIntervalSince(a) < runGap
			{
				showsAuthor = false
			}
			items.append(.message(message, showsAuthor: showsAuthor))
			previous = message
			let handoffs = handoffItems(for: message)
			if !handoffs.isEmpty {
				// The card sits between two messages, so a following one opens a fresh run.
				items.append(contentsOf: handoffs)
				previous = nil
			}
		}
		// A call that is still running and has nothing said yet shows its empty state, not a card.
		for index in calls.indices where !emitted.contains(index) && calls[index].showsCard {
			items.append(card(index))
		}
		return items
	}

	/// One row per spawned session the strip has a pill for, in the server's order.
	static func handoffItems(for message: ChatMessage) -> [ThreadItem] {
		let names = Dictionary(
			message.spawnedSessions.map { ($0.id, $0.actorName) }, uniquingKeysWith: { first, _ in first })
		return message.spawnedSessions.filter { $0.pill != nil }.map { session in
			.handoff(session, behind: session.dependsOn.compactMap { names[$0] })
		}
	}

	/// How one message sits in its run of consecutive messages from one author.
	public struct Run: Equatable, Sendable {
		/// The message just above, when this one continues its run (nil for the first of a run).
		public var previousID: String?
		/// Nothing from the same author follows directly, so this is where the run's tail, time
		/// and status belong.
		public var endsRun: Bool

		public init(previousID: String? = nil, endsRun: Bool = true) {
			self.previousID = previousID
			self.endsRun = endsRun
		}
	}

	/// How far a row sits from the one above it (spec 7 §3 grouping): a message that continues
	/// its sender's run is pulled close; everything else keeps the list gap.
	public enum RowGap: Equatable, Sendable {
		/// Consecutive messages from one sender: the 5pt gap.
		case grouped
		/// A new sender, a divider, a handoff card, or anything that is not a message: the 16pt list gap.
		case list
	}

	public static func gap(before item: ThreadItem) -> RowGap {
		if case .message(_, let showsAuthor) = item, !showsAuthor { return .grouped }
		return .list
	}

	/// The reader's own newest message: the only one that carries a status line.
	public static func latestOwnMessageID(in messages: [ChatMessage], currentActorID: String) -> String? {
		messages.last { $0.actorID == currentActorID && !$0.isSystem }?.id
	}

	/// Messages that carry a status line: the newest own message, plus every own message the server
	/// has not confirmed yet. Without the second part, sending several in a row leaves all but the
	/// last one looking like plain, slightly faded bubbles with no sign they are on their way.
	public static func statusLineIDs(in messages: [ChatMessage], currentActorID: String) -> Set<String> {
		var ids = Set(messages.filter { $0.actorID == currentActorID && !$0.isSystem && $0.isPending }.map(\.id))
		if let latest = latestOwnMessageID(in: messages, currentActorID: currentActorID) { ids.insert(latest) }
		return ids
	}

	/// Run position of every message in `items`, by message id.
	public static func runs(in items: [ThreadItem]) -> [String: Run] {
		var result: [String: Run] = [:]
		for (index, item) in items.enumerated() {
			guard case .message(let message, let showsAuthor) = item else { continue }
			var previousID: String?
			if !showsAuthor, index > 0, case .message(let previous, _) = items[index - 1] {
				previousID = previous.id
			}
			var endsRun = true
			if index + 1 < items.count, case .message(_, let nextShowsAuthor) = items[index + 1], !nextShowsAuthor {
				endsRun = false
			}
			result[message.id] = Run(previousID: previousID, endsRun: endsRun)
		}
		return result
	}

	/// "Today", "Yesterday", or "Mon, Sep 29".
	public static func dayLabel(_ day: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
		if calendar.isDate(day, inSameDayAs: now) { return "Today" }
		if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: y) {
			return "Yesterday"
		}
		return day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
	}

	/// Title for a new conversation when the user doesn't type one: "Alex, Relay".
	public static func defaultTitle(for names: [String]) -> String {
		let list = names.prefix(3).joined(separator: ", ")
		return names.count > 3 ? "\(list) +\(names.count - 3)" : (list.isEmpty ? "New chat" : list)
	}
}
