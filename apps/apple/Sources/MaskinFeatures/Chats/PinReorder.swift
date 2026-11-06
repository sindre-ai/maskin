import CoreTransferable
import MaskinDesign
import MaskinUI
import SwiftUI
import UniformTypeIdentifiers

/// What a pinned row carries while it is dragged: its pin key (a conversation id, or `flow:<id>`).
struct PinDragItem: Codable, Transferable {
	var id: String

	static var transferRepresentation: some TransferRepresentation {
		CodableRepresentation(contentType: .json)
	}
}

/// Long-press then drag a pinned row onto another to move it there (the system lift, the same
/// gesture as everywhere in iOS). `onMove(dragged, target)` persists the order through the store.
/// Off while rows are being selected.
private struct PinReorder: ViewModifier {
	let id: String
	let enabled: Bool
	let onMove: (_ dragged: String, _ target: String) -> Void

	func body(content: Content) -> some View {
		if enabled {
			content
				.draggable(PinDragItem(id: id))
				.dropDestination(for: PinDragItem.self) { items, _ in
					guard let dragged = items.first?.id, dragged != id else { return false }
					MaskinHaptics.play(.selection)
					onMove(dragged, id)
					return true
				}
		} else {
			content
		}
	}
}

extension View {
	func pinReorder(id: String, enabled: Bool, onMove: @escaping (_ dragged: String, _ target: String) -> Void) -> some View {
		modifier(PinReorder(id: id, enabled: enabled, onMove: onMove))
	}
}
