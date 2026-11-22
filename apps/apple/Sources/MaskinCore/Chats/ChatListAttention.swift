import Foundation

/// The attention markers, filter pills and groups of the Chats list (chat list design spec v12 and
/// its states addendum). Pure values, so every rule is tested without a view.

/// The one marker on a row's preview line. A row never shows two: error beats needs you beats
/// working. A Later row shows none.
public enum ChatPreviewMarker: Equatable, Sendable {
	case error(ChatStopReason)
	case needsYou
	case working
}

extension ConversationSummary {
	public var previewMarker: ChatPreviewMarker? {
		if later { return nil }
		if let stopReason { return .error(stopReason) }
		if needsYou { return .needsYou }
		if !working.isEmpty { return .working }
		return nil
	}

	/// A chat that waits on the person: an agent asks, or the last turn stopped. Both count under the
	/// Needs you pill.
	public var needsAttention: Bool { needsYou || stopReason != nil }

	/// Agents running here, by actor id, for the "Agent is working" line and the row's first line.
	public var workingAgentIDs: [String] { working.map(\.agentID) }
}

/// The pills above the list. All is the default (addendum: Needs you as default hides the whole list
/// on a day nothing waits).
public enum ChatListFilter: String, CaseIterable, Sendable, Identifiable {
	case all
	case needsYou = "needs_you"
	case unread
	case working
	case later

	public var id: String { rawValue }

	public var label: String {
		switch self {
		case .all: "All"
		case .needsYou: "Needs you"
		case .unread: "Unread"
		case .working: "Working"
		case .later: "Later"
		}
	}

	/// A Later chat is out of every pill except Later.
	public func includes(_ c: ConversationSummary) -> Bool {
		switch self {
		case .later: c.later
		case .all: !c.later
		case .needsYou: !c.later && c.needsAttention
		case .unread: !c.later && c.isUnread
		case .working: !c.later && !c.working.isEmpty
		}
	}

	/// What the list shows when this pill has no chats. Verbatim from the addendum.
	public var emptyText: String {
		switch self {
		case .all: "No chats yet. Start one with an agent."
		case .needsYou: "Nothing waits on you."
		case .unread: "You are all caught up."
		case .working: "No agent is working right now."
		case .later: "Nothing is on Later. Move a chat here to hide it until it gets a new message."
		}
	}
}

/// The Group by menu.
public enum ChatListGroupBy: String, CaseIterable, Sendable, Identifiable {
	case date, status, agent, tag, type, none

	public var id: String { rawValue }

	public var label: String {
		switch self {
		case .date: "Date"
		case .status: "Status"
		case .agent: "Agent"
		case .tag: "Tag"
		case .type: "Type"
		case .none: "None"
		}
	}
}

/// Every string the list and its toasts say that the addendum fixes. Kept in one place so the copy
/// is checked against the spec in one test.
public enum ChatListCopy {
	public static let markedDone = "Marked done"
	public static let movedToLater = "Moved to Later. A new message brings it back."
	public static let retrying = "Retrying"
	public static let undo = "Undo"
	public static let retry = "Retry"
	public static let listFailed = "Chats did not load."
	public static let noMatches = "No chats match. Try fewer words or remove an operator."
	/// How long a Done or Later toast offers Undo.
	public static let undoSeconds = 6
}

/// One labelled bucket of the list.
public struct ChatListGroup: Identifiable, Equatable, Sendable {
	public var id: String
	public var label: String
	public var section: ChatListTracking.Section
	public var items: [ConversationSummary]
}

public enum ChatListLayout {
	/// The pills' counts: every pill but All shows its count on an unselected pill when above 0.
	public static func counts(_ conversations: [ConversationSummary]) -> [ChatListFilter: Int] {
		var result: [ChatListFilter: Int] = [:]
		for filter in ChatListFilter.allCases where filter != .all {
			result[filter] = conversations.filter(filter.includes).count
		}
		return result
	}

	/// The chats under `filter`, in `groupBy` groups. Empty groups never exist. A chat is in exactly
	/// one group, so nothing shows twice. Within a group the newest activity comes first.
	public static func groups(
		_ conversations: [ConversationSummary], filter: ChatListFilter, groupBy: ChatListGroupBy,
		currentActorID: String?, now: Date = Date(), calendar: Calendar = .current
	) -> [ChatListGroup] {
		let shown = conversations.filter(filter.includes).sorted(by: newestFirst)
		switch groupBy {
		case .none:
			guard !shown.isEmpty else { return [] }
			return [
				ChatListGroup(
					id: "all", label: "", section: .recent, items: shown.filter(\.pinned) + shown.filter { !$0.pinned })
			]
		case .date:
			let today = calendar.startOfDay(for: now)
			func isToday(_ c: ConversationSummary) -> Bool {
				guard let date = c.activityDate else { return false }
				return calendar.startOfDay(for: date) >= today
			}
			let rest = shown.filter { !$0.pinned }
			return [
				group("pinned", "Pinned", .pinned, shown.filter(\.pinned)),
				group("today", "Today", .today, rest.filter(isToday)),
				group("earlier", "Earlier", .earlier, rest.filter { !isToday($0) }),
			].compactMap { $0 }
		case .status:
			let rest = shown.filter { !$0.pinned }
			// Stopped chats sit at the top of Needs you.
			let needs = rest.filter(\.needsAttention)
			let attention = needs.filter { $0.stopReason != nil } + needs.filter { $0.stopReason == nil }
			let remaining = rest.filter { !$0.needsAttention }
			let working = remaining.filter { !$0.working.isEmpty }
			let unread = remaining.filter { $0.working.isEmpty && $0.isUnread }
			let earlier = remaining.filter { $0.working.isEmpty && !$0.isUnread }
			return [
				group("pinned", "Pinned", .pinned, shown.filter(\.pinned)),
				group("needs_you", "Needs you", .needsYou, attention),
				group("working", "Working", .working, working),
				group("unread", "Unread", .unread, unread),
				group("earlier", "Earlier", .earlier, earlier),
			].compactMap { $0 }
		case .agent:
			return named(shown, section: .agent, none: "No agent") { c in
				let others = c.others(excluding: currentActorID)
				return (others.first { $0.kind == .agent } ?? others.first)?.name
			}
		case .tag:
			return named(shown, section: .tag, none: "No tag") { $0.tags.first }
		case .type:
			func kind(_ c: ConversationSummary) -> Int { c.isDirect ? 0 : c.isGroupChat(excluding: currentActorID) ? 2 : 1 }
			return [
				group("direct", "Direct", .typeDirect, shown.filter { kind($0) == 0 }),
				group("topic", "Topic", .typeTopic, shown.filter { kind($0) == 1 }),
				group("group", "Group", .typeGroup, shown.filter { kind($0) == 2 }),
			].compactMap { $0 }
		}
	}

	/// Where the row with `id` sits among the rows on screen, 1-based, and its group's section.
	public static func place(of id: String, in groups: [ChatListGroup]) -> (section: ChatListTracking.Section, position: Int)? {
		var position = 0
		for group in groups {
			for item in group.items {
				position += 1
				if item.id == id { return (group.section, position) }
			}
		}
		return nil
	}

	// MARK: Helpers

	private static func group(
		_ id: String, _ label: String, _ section: ChatListTracking.Section, _ items: [ConversationSummary]
	) -> ChatListGroup? {
		items.isEmpty ? nil : ChatListGroup(id: id, label: label, section: section, items: items)
	}

	/// One group per name, in the order the names first appear (newest chat first), the nameless
	/// last. The same order the web list uses.
	private static func named(
		_ shown: [ConversationSummary], section: ChatListTracking.Section, none: String,
		name: (ConversationSummary) -> String?
	) -> [ChatListGroup] {
		var order: [String] = []
		var byName: [String: [ConversationSummary]] = [:]
		var nameless: [ConversationSummary] = []
		for c in shown {
			if let n = name(c), !n.isEmpty {
				if byName[n] == nil { order.append(n) }
				byName[n, default: []].append(c)
			} else {
				nameless.append(c)
			}
		}
		let groups = order.compactMap { group("\(section.rawValue):\($0)", $0, section, byName[$0] ?? []) }
		return groups + [group("\(section.rawValue):none", none, section, nameless)].compactMap { $0 }
	}

	private static func newestFirst(_ a: ConversationSummary, _ b: ConversationSummary) -> Bool {
		let (x, y) = (a.activityDate ?? .distantPast, b.activityDate ?? .distantPast)
		return x == y ? a.id < b.id : x > y
	}
}

/// Which search operators a typed query used, for the `operators` property of `chat_list_search_used`.
/// A port of the web list's reader: the same operators in the order they first appear, once each,
/// and never the words after them.
public enum ChatListSearchOperators {
	public static func used(in text: String) -> [ChatListTracking.SearchOperator] {
		var used: [ChatListTracking.SearchOperator] = []
		func add(_ op: ChatListTracking.SearchOperator) { if !used.contains(op) { used.append(op) } }
		// A quoted phrase is one token: blank it before reading the words around it.
		var rest = ""
		var inPhrase = false
		var pending = ""
		for ch in text {
			if ch == "\"" {
				if inPhrase {
					add(.phrase)
					rest += " "
					inPhrase = false
					pending = ""
				} else {
					inPhrase = true
					pending = ""
				}
				continue
			}
			if inPhrase { pending.append(ch) } else { rest.append(ch) }
		}
		// An unclosed quote is plain text, like the web's regex which needs both quotes.
		if inPhrase { rest += "\"" + pending }
		for token in rest.split(whereSeparator: \.isWhitespace) {
			let t = String(token)
			let lower = t.lowercased()
			if t.hasPrefix("@"), t.count > 1 { add(.agent) }
			else if lower.hasPrefix("from:"), t.count > 5 { add(.from) }
			else if lower.hasPrefix("with:"), t.count > 5 { add(.with) }
			else if lower.hasPrefix("team:"), t.count > 5 { add(.team) }
			else if lower.hasPrefix("is:"), t.count > 3 { add(.is) }
			else if t.hasPrefix("-"), t.count > 1 { add(.exclude) }
		}
		return used
	}
}

/// The words of the line under the person's last message while agents work: "Forge and Sage are
/// working", each name a link to that agent's session.
public enum ChatWorkingLine {
	/// What follows name `index` of `total`: nothing after the last, " and" before it, a comma otherwise.
	public static func joiner(after index: Int, of total: Int) -> String {
		if index >= total - 1 { return "" }
		return index == total - 2 ? " and" : ","
	}

	public static func verb(for total: Int) -> String { total == 1 ? "is working" : "are working" }
}
