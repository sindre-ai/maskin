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

/// Which button a list row's swipe shows. An agent's ask comes first on both sides; with none, the
/// right swipe approves or marks done, and the left swipe archives, or deletes when the type has
/// no archive status.
enum ObjectRowSwipe: Equatable {
	case approveAsk, approve, done, hold, archive, delete

	/// Swipe right. Nil when the row has nothing to approve or finish.
	static func leading(hasAsk: Bool, needsYou: Bool, canApprove: Bool, canMarkDone: Bool) -> ObjectRowSwipe? {
		if hasAsk { return .approveAsk }
		if needsYou, canApprove { return .approve }
		if canMarkDone { return .done }
		return nil
	}

	/// Swipe left. Always one button.
	static func trailing(hasAsk: Bool, canArchive: Bool) -> ObjectRowSwipe {
		if hasAsk { return .hold }
		return canArchive ? .archive : .delete
	}
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

	private var menuPlan: ObjectMenuPlan {
		ObjectMenuPlan(
			object: object, ask: ask, store: store, showsOpen: onOpen != nil, showsSelect: onSelect != nil)
	}

	var body: some View {
		let plan = menuPlan
		if plan.showsOpen, let onOpen {
			Button { onOpen() } label: { Label("Open", systemImage: "arrow.up.right.square") }
		}
		if let ask, let planAsk = plan.ask {
			Section("Needs you") {
				Button {
					MaskinHaptics.play(.success)
					askActions.approve(ask)
				} label: {
					Label(planAsk.approveLabel, systemImage: "checkmark")
				}
				Button {
					onHold(ask)
				} label: {
					Label("Hold", systemImage: "pause")
				}
			}
		} else if let target = plan.approveTarget {
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
			ForEach(plan.statuses, id: \.self) { status in
				Button {
					MaskinHaptics.play(.selection)
					Task {
						let moved = await store.setStatusRecording([object.id], to: status)
						if !moved.undo.isEmpty {
							offerUndo(moved.undo, "Moved to \(MaskinStatus.label(for: status)). Undo.")
						}
					}
				} label: {
					if status == plan.currentStatus {
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
			Label(plan.starTitle, systemImage: plan.isStarred ? "star.slash" : "star")
		}
		if plan.showsDone {
			Button {
				Task {
					if let undo = await store.markDone(object.id) { offerUndo(undo, "Marked done. Undo.") }
				}
			} label: {
				Label("Done", systemImage: "checkmark.circle")
			}
		}
		if plan.showsArchive {
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
		if plan.showsSelect, let onSelect {
			Divider()
			Button { onSelect() } label: { Label("Select", systemImage: "checkmark.circle") }
		}
	}
}
