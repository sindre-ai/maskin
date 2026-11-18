import MaskinCore

/// Which items the long-press menu of one object offers (the list row's menu, the search result's
/// menu), decided from plain values so it tests without a view or a store. `ObjectMenuItems` only
/// draws what this says.
struct ObjectMenuPlan: Equatable {
	/// "Open" leads the menu when the screen can open the object.
	var showsOpen: Bool
	/// The agent's ask: "Needs you" with the approve option's label and "Hold". Nil with no ask.
	var ask: Ask?
	/// "Approve": the status it moves to. Only with no ask, and only when the type has a next status.
	var approveTarget: String?
	/// The "Status" submenu: the type's statuses in workspace order, the current one ticked.
	var statuses: [String]
	var currentStatus: String
	var isStarred: Bool
	/// "Done": only with no ask, and only while the object is not already in its done status.
	var showsDone: Bool
	var showsArchive: Bool
	/// "Delete" is always there.
	var showsSelect: Bool

	struct Ask: Equatable {
		var approveLabel: String
	}

	/// The title of the star item.
	var starTitle: String { isStarred ? "Remove from favourites" : "Add to favourites" }

	init(
		showsOpen: Bool, ask: ObjectAsk?, approveTarget: String?, statuses: [String], currentStatus: String,
		isStarred: Bool, doneTarget: String?, canArchive: Bool, showsSelect: Bool
	) {
		self.showsOpen = showsOpen
		self.ask = ask.map { Ask(approveLabel: $0.approveOption?.label ?? "Approve") }
		// An ask answers the object; the plain Approve and Done would be a second way to answer it.
		self.approveTarget = ask == nil ? approveTarget : nil
		self.statuses = statuses
		self.currentStatus = currentStatus
		self.isStarred = isStarred
		self.showsDone = ask == nil && doneTarget != nil
		self.showsArchive = canArchive
		self.showsSelect = showsSelect
	}

	/// The plan for `object` as the store sees it, so the targets are the ones the actions use.
	@MainActor
	init(object: WorkObject, ask: ObjectAsk?, store: ObjectsStore, showsOpen: Bool, showsSelect: Bool) {
		self.init(
			showsOpen: showsOpen, ask: ask, approveTarget: store.approveTarget(for: object),
			statuses: store.directory.schema.statuses(for: object.type), currentStatus: object.status,
			isStarred: object.isStarred, doneTarget: store.doneTarget(for: object),
			canArchive: store.canArchive([object.id]), showsSelect: showsSelect)
	}

	/// The statuses a board card's "Move to" offers: its type's statuses, its own left out.
	static func moveTargets(statuses: [String], currentStatus: String) -> [String] {
		statuses.filter { $0 != currentStatus }
	}
}
