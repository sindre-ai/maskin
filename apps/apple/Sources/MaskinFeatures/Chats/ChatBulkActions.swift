import MaskinCore

/// What the chat list's selection bar offers for the chats picked, and what its archive Undo
/// brings back, so the view only draws it and the rules can be tested.
struct ChatBulkActions {
	/// One button in the selection bar.
	enum Item: Hashable {
		case pin, unpin, markRead, markUnread, archive

		var title: String {
			switch self {
			case .pin: "Pin"
			case .unpin: "Unpin"
			case .markRead: "Mark as read"
			case .markUnread: "Mark as unread"
			case .archive: "Archive"
			}
		}

		var systemImage: String {
			switch self {
			case .pin: "pin"
			case .unpin: "pin.slash"
			case .markRead: "envelope.open"
			case .markUnread: "envelope.badge"
			case .archive: "archivebox"
			}
		}
	}

	/// The chats picked, in list order.
	var ids: [String]

	/// Archive is the primary button; the rest sit in the "More" menu, in the order shown.
	var primary: Item { .archive }
	var moreItems: [Item] { [.pin, .unpin, .markRead, .markUnread] }

	/// Nothing picked, nothing to do: both the menu and Archive are dimmed.
	var isEnabled: Bool { !ids.isEmpty }

	/// The toast after an archive, and what its Undo unarchives.
	struct ArchiveUndo: Equatable {
		var message: String
		/// Every chat that was sent to be archived. Unarchiving one that never archived is a no-op.
		var idsToRestore: [String]
	}

	/// The Undo offer for an archive of `ids` that ended as `result`: none when nothing archived.
	static func archiveUndo(ids: [String], result: BulkResult) -> ArchiveUndo? {
		guard result.succeeded > 0 else { return nil }
		return ArchiveUndo(message: "Archived \(result.succeeded). Undo.", idsToRestore: ids)
	}
}
