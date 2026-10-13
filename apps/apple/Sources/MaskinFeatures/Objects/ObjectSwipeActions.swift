import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Answers to an agent's ask, wired by the screen to the same `DecisionService` the For You feed
/// uses, so Approve / Hold here show the same receipt and Undo there.
struct ObjectAskActions {
	/// Take the agent's recommended option (or answer "Approved").
	var approve: (ObjectAsk) -> Void = { _ in }
	/// Hold, with an optional one-line reason that goes on the timeline.
	var hold: (ObjectAsk, String?) -> Void = { _, _ in }
	/// Undo the answer while its window is open.
	var undo: (ObjectAsk) -> Void = { _ in }
}

/// The shared menu body for one object (the row's context menu and the board card).
struct ObjectMenuItems: View {
	let object: WorkObject
	let ask: ObjectAsk?
	let store: ObjectsStore
	let askActions: ObjectAskActions
	let onHold: (ObjectAsk) -> Void
	/// Offers "… Undo." for a status change that landed.
	let offerUndo: (StatusUndo, String) -> Void
	/// Holds a delete for the undo window and offers the way back.
	let deleteHeld: (WorkObject) -> Void
	var onOpen: (() -> Void)?
	var onSelect: (() -> Void)?

	var body: some View {
		if let onOpen {
			Button { onOpen() } label: { Label("Open", systemImage: "arrow.up.right.square") }
		}
		if let ask {
			Section("Needs you") {
				Button {
					MaskinHaptics.play(.success)
					askActions.approve(ask)
				} label: {
					Label(ask.approveOption?.label ?? "Approve", systemImage: "checkmark")
				}
				Button {
					onHold(ask)
				} label: {
					Label("Hold", systemImage: "pause")
				}
			}
		} else if let target = store.approveTarget(for: object) {
			Button {
				MaskinHaptics.play(.success)
				Task {
					if let undo = await store.approve(object.id) {
						offerUndo(undo, "Moved to \(MaskinStatus.label(for: target)). Undo.")
					}
				}
			} label: {
				Label("Approve", systemImage: "checkmark")
			}
		}
		Menu {
			ForEach(store.directory.schema.statuses(for: object.type), id: \.self) { status in
				Button {
					MaskinHaptics.play(.selection)
					Task {
						let moved = await store.setStatusRecording([object.id], to: status)
						if !moved.undo.isEmpty {
							offerUndo(moved.undo, "Moved to \(MaskinStatus.label(for: status)). Undo.")
						}
					}
				} label: {
					if status == object.status {
						Label(MaskinStatus.sentenceLabel(for: status), systemImage: "checkmark")
					} else {
						Text(MaskinStatus.sentenceLabel(for: status))
					}
				}
			}
		} label: {
			Label("Status", systemImage: "circle.dashed")
		}
		Button {
			MaskinHaptics.play(.selection)
			Task { await store.toggleStar(object.id) }
		} label: {
			Label(object.isStarred ? "Remove from favourites" : "Add to favourites", systemImage: object.isStarred ? "star.slash" : "star")
		}
		if ask == nil, store.doneTarget(for: object) != nil {
			Button {
				Task {
					if let undo = await store.markDone(object.id) { offerUndo(undo, "Marked done. Undo.") }
				}
			} label: {
				Label("Done", systemImage: "checkmark.circle")
			}
		}
		if store.canArchive([object.id]) {
			Button {
				Task {
					if let undo = await store.archive(object.id) { offerUndo(undo, "Archived. Undo.") }
				}
			} label: {
				Label("Archive", systemImage: "archivebox")
			}
		}
		Button(role: .destructive) {
			deleteHeld(object)
		} label: {
			Label("Delete", systemImage: "trash")
		}
		if let onSelect {
			Divider()
			Button { onSelect() } label: { Label("Select", systemImage: "checkmark.circle") }
		}
	}
}
