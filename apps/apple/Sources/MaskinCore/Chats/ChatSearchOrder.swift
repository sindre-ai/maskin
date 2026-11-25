import Foundation

/// How a chat search match is ranked, the same on every surface: the server search (web, Cmd+K,
/// the Search page) and the iPhone Chats list and Search tab. Order of a result list:
/// match tier, then open before archived, then unread before read, then newest message first.
/// `packages/shared/fixtures/chat-search-order.json` holds the cases the server and these tests both read.
public enum ChatSearchOrder {
	/// Lower is better: 0 a whole word of a name or title, 1 the start of a word, 2 the letters inside
	/// a word, 3 a hit only in a message. A chat still on the placeholder title passes no title.
	public static func tier(names: [String], query: String) -> Int {
		names.map { name -> Int in
			if ActorSearch.isWholeWord(name: name, query: query) { return 0 }
			guard let rank = ActorSearch.rank(name: name, query: query) else { return 3 }
			return rank <= 1 ? 1 : 2
		}.min() ?? 3
	}
}
