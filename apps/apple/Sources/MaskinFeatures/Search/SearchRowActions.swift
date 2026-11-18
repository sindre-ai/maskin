import MaskinCore
import MaskinDesign
import Observation
import SwiftUI

/// Which long-press menu a search result gets. A chat or object whose row has not arrived in its
/// store yet gets none until it does; agents and files never get one.
enum SearchRowMenu: Equatable {
	case chat, object, none

	static func of(_ kind: SearchKind, rowLoaded: Bool) -> SearchRowMenu {
		switch kind {
		case .chat: rowLoaded ? .chat : .none
		case .object: rowLoaded ? .object : .none
		case .agent, .file: .none
		}
	}

	/// The chat list's menu for a chat: Pin, Read, Archive and Delete. No Select (search has no
	/// bulk mode), no reordering, and no "More" row.
	static func chatActions(
		isPinned: Bool, isUnread: Bool, pin: @escaping () -> Void, toggleRead: @escaping () -> Void,
		archive: @escaping () -> Void, delete: @escaping () -> Void
	) -> TeamRowActions {
		TeamRowActions(
			isPinned: isPinned, isUnread: isUnread, pin: pin, toggleRead: toggleRead, archive: archive,
			delete: delete, more: {})
	}
}

/// The long-press menu of a search result: the chat list's menu for a chat, the objects list's
/// menu for an object or a flow. Agents and files have no menu in their own lists, so they get
/// none here.
///
/// Search keeps no chat or object lists of its own and the menus act on a store's rows, so this
/// holds one of each and fills them for the words typed (`load`). A result whose row has not
/// arrived yet shows no menu until it does.
@MainActor
@Observable
final class SearchRowActions {
	let search: SearchStore
	let chats: ConversationsStore
	let objects: ObjectsStore
	var undoOffer: UndoOffer?
	/// The chat waiting for "Delete this conversation?" to be confirmed.
	var deleteTarget: SearchResult?
	/// Opens a result, for the objects menu's Open.
	var open: (SearchResult) -> Void = { _ in }

	/// How many more chat pages to read while looking for the chats that matched.
	private static let extraChatPages = 2

	init(search: SearchStore, chats: ConversationsStore, objects: ObjectsStore) {
		self.search = search
		self.chats = chats
		self.objects = objects
	}

	/// Reads the chats, and the objects matching `query`, so the results' menus have rows to act on.
	func load(query: String) async {
		async let chatsLoad: Void = loadChats()
		async let objectsLoad: Void = loadObjects(query)
		_ = await (chatsLoad, objectsLoad)
	}

	private func loadChats() async {
		await chats.refresh()
		for _ in 0..<Self.extraChatPages where chats.hasMore { await chats.loadMore() }
	}

	private func loadObjects(_ query: String) async {
		async let directory: Void = objects.directory.load()
		await objects.setSearch(query.trimmingCharacters(in: .whitespacesAndNewlines))
		await directory
	}

	// MARK: Menu

	@ViewBuilder
	func menu(for result: SearchResult) -> some View {
		let chat = result.kind == .chat ? chats.conversation(id: result.entityId) : nil
		let object = result.kind == .object ? objects.objects.first(where: { $0.id == result.entityId }) : nil
		switch SearchRowMenu.of(result.kind, rowLoaded: chat != nil || object != nil) {
		case .chat:
			if let chat { TeamRowMenuItems(actions: chatActions(chat, result)) }
		case .object:
			if let object {
				ObjectMenuItems(
					object: object, ask: nil, store: objects, askActions: ObjectAskActions(), onHold: { _ in },
					offerUndo: { [self] undo, message in offerUndo(undo, message: message) },
					deleteHeld: { [self] in deleteHeld($0, result: result) },
					onOpen: { [self] in open(result) })
			}
		case .none:
			EmptyView()
		}
	}

	// MARK: Chats

	/// What the chat list builds for a conversation row, minus Select and the "More" swipe.
	func chatActions(_ chat: ConversationSummary, _ result: SearchResult) -> TeamRowActions {
		SearchRowMenu.chatActions(
			isPinned: chat.pinned, isUnread: chat.isUnread,
			pin: { [self] in Task { await chats.setPinned(chat.id, !chat.pinned) } },
			toggleRead: { [self] in
				Task { if chat.isUnread { await chats.markRead([chat.id]) } else { await chats.markUnread(chat.id) } }
			},
			archive: { [self] in archive(result) },
			delete: { [self] in deleteTarget = result })
	}

	func archive(_ result: SearchResult) {
		Task {
			let done = await chats.setArchived([result.entityId], true)
			guard done.succeeded > 0 else { return }
			search.remove(result)
			undoOffer = UndoOffer(message: "Archived 1. Undo.") { [self] in
				_ = await chats.setArchived([result.entityId], false)
				search.invalidateDirectories()
				await search.retry()
			}
		}
	}

	func delete(_ result: SearchResult) {
		Task {
			await chats.delete(result.entityId)
			// A refused delete puts the row back in the store.
			if chats.conversation(id: result.entityId) == nil { search.remove(result) }
		}
	}

	// MARK: Objects

	/// Removes the row now, sends the delete after the toast's window, Undo puts it back.
	func deleteHeld(_ object: WorkObject, result: SearchResult) {
		MaskinHaptics.play(.selection)
		Task { await objects.delete(object.id, holdFor: .seconds(6)) }
		search.remove(result)
		undoOffer = UndoOffer(message: "Deleted. Undo.") { [self] in
			objects.undoDelete(object.id)
			search.invalidateDirectories()
			await search.retry()
		}
	}

	private func offerUndo(_ undo: StatusUndo, message: String) {
		guard !undo.isEmpty else { return }
		for change in undo.changes { search.setStatus(change.to, ofObject: change.id) }
		undoOffer = UndoOffer(message: message) { [self] in
			await objects.undo(undo)
			for change in undo.changes { search.setStatus(change.from, ofObject: change.id) }
		}
	}
}
