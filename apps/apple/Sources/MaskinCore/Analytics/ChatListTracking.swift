import Foundation

/// How the Chats list is used, for the Chat list rework bet. Two events with the web app's names
/// and property values (`chat_opened_from_list`, `chat_list_search_used`), categories only: never a
/// chat title, the search text or a chat id.
///
/// `section` is the list section the opened row sat in. `agent` and `room` are set by the rows that
/// add them; until then direct messages and every dated or person group read as `recent`, like the
/// web list. The chat list bet adds `marker`, `filter` and `group_by` to the open, and the
/// `chat_row_action` event, with the same names and values as web and `surface` set by the app.
public enum ChatListTracking {
	public enum Section: String, Sendable {
		case pinned, unread, agent, recent, room, search
		case today, yesterday, earlier, working, tag
		case typeDirect = "type_direct", typeTopic = "type_topic", typeGroup = "type_group"
		case needsYou = "needs_you"
	}

	/// The marker the opened row carried: its one preview marker, else unread, else later (a row
	/// under the Later pill shows none), else none.
	public enum Marker: String, Sendable {
		case none, unread, working, later, error
		case needsYou = "needs_you"
	}

	/// What a row action did. Retry is the red dot's action.
	public enum RowAction: String, Sendable {
		case done, later, undo, retry
	}

	/// How the action was reached on the phone. An Undo reports how the action it takes back was reached.
	public enum RowActionVia: String, Sendable {
		case swipe, menu
	}

	/// The operators a search used, a fixed list: never the words typed.
	public enum SearchOperator: String, CaseIterable, Sendable {
		case agent, from, with, team, `is`, phrase, exclude, none
	}

	public static func marker(of c: ConversationSummary) -> Marker {
		if c.later { return .later }
		switch c.previewMarker {
		case .error: return .error
		case .needsYou: return .needsYou
		case .working: return .working
		case nil: return c.isUnread ? .unread : .none
		}
	}

	/// `list` for a row opened from the list as it stands, `search` for one opened from the
	/// results of the list search (its section is `search` too).
	public enum Source: String, Sendable {
		case list, search
	}

	public struct Place: Equatable, Sendable {
		public var source: Source
		public var section: Section
		/// 1-based place among the rows on screen.
		public var position: Int
		/// Set by the new list; the older places (archive, search) leave them out.
		public var marker: Marker?
		public var filter: ChatListFilter?
		public var groupBy: ChatListGroupBy?
		public init(
			source: Source, section: Section, position: Int, marker: Marker? = nil,
			filter: ChatListFilter? = nil, groupBy: ChatListGroupBy? = nil
		) {
			self.source = source
			self.section = section
			self.position = position
			self.marker = marker
			self.filter = filter
			self.groupBy = groupBy
		}
	}

	/// A place as a bucket, so no single chat can be told apart.
	public static func positionBucket(_ position: Int) -> String {
		switch position {
		case ...1: "1"
		case 2...3: "2_3"
		case 4...10: "4_10"
		case 11...25: "11_25"
		default: "26_plus"
		}
	}

	/// Where a hit of the list search sits among the hits on screen. Nil when it is not among them.
	public static func searchPlace(of conversationID: String, among hits: [ChatSearchHit]) -> Place? {
		hits.firstIndex(where: { $0.id == conversationID })
			.map { Place(source: .search, section: .search, position: $0 + 1) }
	}

	public static func resultCountBucket(_ count: Int) -> String {
		switch count {
		case ...0: "0"
		case 1: "1"
		case 2...5: "2_5"
		case 6...20: "6_20"
		default: "21_plus"
		}
	}
}

extension TeamLayout {
	/// Where the row for `conversationID` sits on screen: pinned tiles first, then each section's
	/// rows, then the archived matches of a search. A person row holds several chats and counts as
	/// one place. Nil when the chat is not in the layout. While `searching`, the place reads as a
	/// search open wherever the row is.
	public func chatListPlace(of conversationID: String, searching: Bool) -> ChatListTracking.Place? {
		func place(_ section: ChatListTracking.Section, _ position: Int) -> ChatListTracking.Place {
			searching
				? ChatListTracking.Place(source: .search, section: .search, position: position)
				: ChatListTracking.Place(source: .list, section: section, position: position)
		}
		var position = 0
		for tile in tiles {
			position += 1
			if case .conversation(let c) = tile.kind, c.id == conversationID { return place(.pinned, position) }
		}
		for section in sections {
			let area: ChatListTracking.Section = section.kind == .unread ? .unread : .recent
			for row in section.rows {
				position += 1
				switch row.kind {
				case .conversation(let c) where c.id == conversationID:
					// The Pinned chip lists pinned chats as ordinary rows.
					return place(c.pinned ? .pinned : area, position)
				case .person(let p) where p.conversations.contains(where: { $0.id == conversationID }):
					return place(area, position)
				default: break
				}
			}
		}
		return nil
	}

	/// How many chats the list shows: the result count of a search.
	public var shownChatCount: Int { conversationIDs.count }
}

extension Analytics {
	/// A chat was opened from the list. Only a person's tap sends this, not a deep link or a new chat.
	public func chatOpenedFromList(_ place: ChatListTracking.Place) {
		var properties: AnalyticsProperties = [
			"source": .string(place.source.rawValue), "section": .string(place.section.rawValue),
			"position_bucket": .string(ChatListTracking.positionBucket(place.position)),
		]
		if let marker = place.marker { properties["marker"] = .string(marker.rawValue) }
		if let filter = place.filter { properties["filter"] = .string(filter.rawValue) }
		if let groupBy = place.groupBy { properties["group_by"] = .string(groupBy.rawValue) }
		track("chat_opened_from_list", properties)
	}

	/// A Done, Later, Undo or Retry on a row, by swipe or menu. Categories only.
	public func chatRowAction(_ action: ChatListTracking.RowAction, via: ChatListTracking.RowActionVia) {
		track("chat_row_action", ["action": .string(action.rawValue), "via": .string(via.rawValue)])
	}

	/// The list search settled on a query. Sends how many chats it found, never the text.
	public func chatListSearchUsed(resultCount: Int, operators: [ChatListTracking.SearchOperator] = []) {
		let used = operators.isEmpty ? [ChatListTracking.SearchOperator.none] : operators
		track(
			"chat_list_search_used",
			[
				"result_count_bucket": .string(ChatListTracking.resultCountBucket(resultCount)),
				"operators": .string(used.map(\.rawValue).joined(separator: ",")),
			])
	}
}
