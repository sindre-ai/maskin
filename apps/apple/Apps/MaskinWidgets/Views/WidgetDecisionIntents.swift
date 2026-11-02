import AppIntents
import MaskinCore
import WidgetKit

/// Decides in place from the medium widget. Runs in the widget extension: records the answer as
/// held (the widget redraws with "You chose …" and Undo), waits out the Undo window, then sends it
/// the way a notification button does. Hold and irreversible options never reach here: they open
/// the app (see `WidgetSnapshot.Decision.decidesInPlace`).
struct DecideInWidgetIntent: AppIntent {
	static let title: LocalizedStringResource = "Decide"
	static let description = IntentDescription("Answers a decision an agent is waiting on.")
	static let openAppWhenRun = false
	/// Not offered in Shortcuts or Spotlight: it only makes sense on the widget's own button.
	static let isDiscoverable = false

	@Parameter(title: "Object") var objectId: String
	@Parameter(title: "Answer") var label: String

	init() {}
	init(objectId: String, label: String) {
		self.objectId = objectId
		self.label = label
	}

	func perform() async throws -> some IntentResult {
		let service = WidgetRuntime.decisions()
		guard let snapshot = FileWidgetSnapshotCache().load(),
			let decision = snapshot.decisions.first(where: { $0.objectId == objectId }),
			service.choose(decision, label: label, workspaceId: snapshot.workspaceId) != nil
		else { return .result() }
		WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.needsYou)
		await service.settle(objectId: objectId)
		WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.needsYou)
		return .result()
	}
}

/// Takes the answer back while it is still inside the Undo window.
struct UndoWidgetDecisionIntent: AppIntent {
	static let title: LocalizedStringResource = "Undo"
	static let description = IntentDescription("Takes back an answer given from the widget.")
	static let openAppWhenRun = false
	static let isDiscoverable = false

	@Parameter(title: "Object") var objectId: String

	init() {}
	init(objectId: String) { self.objectId = objectId }

	func perform() async throws -> some IntentResult {
		WidgetRuntime.decisions().undo(objectId: objectId)
		WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.needsYou)
		return .result()
	}
}
