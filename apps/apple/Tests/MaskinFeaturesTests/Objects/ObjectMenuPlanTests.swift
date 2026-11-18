import MaskinCore
import Testing

@testable import MaskinFeatures

/// What the objects list's long-press menu and the board card's "Move to" offer, per type and status.
@Suite("ObjectMenuPlan")
struct ObjectMenuPlanTests {
	/// The plan for an object of `type` in `status`, with the targets the store would resolve from
	/// the same schema (`approveTarget`, `doneTarget`, `canArchive`).
	private func makePlan(
		_ type: String, _ status: String, ask: ObjectAsk? = nil, starred: Bool = false,
		showsOpen: Bool = true, showsSelect: Bool = true, schema: ObjectsSchema = .fallback
	) -> ObjectMenuPlan {
		let statuses = schema.statuses(for: type)
		let done = StatusFlow.doneTarget(in: statuses)
		return ObjectMenuPlan(
			showsOpen: showsOpen, ask: ask, approveTarget: StatusFlow.approveTarget(from: status, in: statuses),
			statuses: statuses, currentStatus: status, isStarred: starred, doneTarget: done == status ? nil : done,
			canArchive: StatusFlow.archiveTarget(in: statuses) != nil, showsSelect: showsSelect)
	}

	private func ask(_ options: [DecisionOption]) -> ObjectAsk {
		ObjectAsk(objectId: "o", askedBy: "Forge", text: "Ship it?", options: options)
	}

	// MARK: Approve and Done, per type and status

	@Test("a task in progress offers Approve (to validated), Done and Archive")
	func taskInProgress() {
		let plan = makePlan("task", "in_progress")
		#expect(plan.approveTarget == "validated")
		#expect(plan.showsDone)
		#expect(plan.showsArchive)
		#expect(plan.ask == nil)
	}

	@Test("a task not yet started has nothing to approve but can be marked done")
	func taskNotStarted() {
		for status in ["backlog", "todo"] {
			let plan = makePlan("task", status)
			#expect(plan.approveTarget == nil)
			#expect(plan.showsDone)
		}
	}

	@Test("a task in review has no later active status, so no Approve")
	func taskInReview() {
		let plan = makePlan("task", "in_review")
		#expect(plan.approveTarget == nil)
		#expect(plan.showsDone)
	}

	@Test("a task already at its first finished status hides Done and Approve")
	func taskValidated() {
		let plan = makePlan("task", "validated")
		#expect(plan.approveTarget == nil)
		#expect(!plan.showsDone)
	}

	@Test("a live bet approves to succeeded; an opportunity does not approve")
	func betApprove() {
		#expect(makePlan("bet", "live").approveTarget == "succeeded")
		#expect(makePlan("bet", "active").approveTarget == "succeeded")
		#expect(makePlan("bet", "opportunity").approveTarget == nil)
	}

	@Test("a clustered insight approves to scored, and archives to discarded")
	func insightClustered() {
		let plan = makePlan("insight", "clustered")
		#expect(plan.approveTarget == "scored")
		#expect(plan.showsDone)
		#expect(plan.showsArchive)
	}

	@Test("a type with no done and no cancelled status offers neither Done nor Archive")
	func typeWithoutDoneOrArchive() {
		let schema = ObjectsSchema(
			types: ["note"], displayNames: ["note": "Note"], statuses: ["note": ["draft", "published"]])
		let plan = makePlan("note", "draft", schema: schema)
		#expect(!plan.showsDone)
		#expect(!plan.showsArchive)
		#expect(plan.approveTarget == nil)
	}

	// MARK: An agent's ask

	@Test("an ask replaces Approve and Done, and takes the recommended option's label")
	func askReplacesApproveAndDone() {
		let plan = makePlan(
			"task", "in_progress",
			ask: ask([DecisionOption(label: "Hold off"), DecisionOption(label: "Ship", recommended: true)]))
		#expect(plan.ask == ObjectMenuPlan.Ask(approveLabel: "Ship"))
		#expect(plan.approveTarget == nil)
		#expect(!plan.showsDone)
		// Archive and the status menu stay.
		#expect(plan.showsArchive)
		#expect(!plan.statuses.isEmpty)
	}

	@Test("with no recommended option the ask takes the first one that is not destructive")
	func askSkipsDestructive() {
		let plan = makePlan(
			"task", "todo",
			ask: ask([DecisionOption(label: "Send to everyone", destructive: true), DecisionOption(label: "Wait")]))
		#expect(plan.ask?.approveLabel == "Wait")
	}

	@Test("an ask with no usable option is answered with a plain Approve")
	func askWithoutOptions() {
		#expect(makePlan("task", "todo", ask: ask([])).ask?.approveLabel == "Approve")
		let onlyDestructive = ask([DecisionOption(label: "Delete it", destructive: true)])
		#expect(makePlan("task", "todo", ask: onlyDestructive).ask?.approveLabel == "Approve")
	}

	// MARK: The rest of the menu

	@Test("the status menu lists the type's statuses in workspace order and knows the current one")
	func statusMenu() {
		let plan = makePlan("bet", "live")
		#expect(plan.statuses == ObjectsSchema.fallback.statuses(for: "bet"))
		#expect(plan.currentStatus == "live")
		#expect(plan.statuses.contains(plan.currentStatus))
	}

	@Test("the star item follows whether the object is a favourite")
	func starTitle() {
		#expect(makePlan("task", "todo", starred: false).starTitle == "Add to favourites")
		#expect(makePlan("task", "todo", starred: true).starTitle == "Remove from favourites")
	}

	@Test("Open and Select show only where the screen can open or select")
	func openAndSelect() {
		let both = makePlan("task", "todo")
		#expect(both.showsOpen)
		#expect(both.showsSelect)
		let neither = makePlan("task", "todo", showsOpen: false, showsSelect: false)
		#expect(!neither.showsOpen)
		#expect(!neither.showsSelect)
	}

	// MARK: Board card

	@Test("a board card moves to every status of its type except its own, in order")
	func moveTargetsLeaveOutCurrent() {
		let statuses = ObjectsSchema.fallback.statuses(for: "task")
		let targets = ObjectMenuPlan.moveTargets(statuses: statuses, currentStatus: "in_progress")
		#expect(targets == ["backlog", "todo", "in_review", "validated", "done", "discarded"])
		#expect(!targets.contains("in_progress"))
	}

	@Test("a card in a status its type does not list can move to all of them")
	func moveTargetsUnknownCurrent() {
		let statuses = ObjectsSchema.fallback.statuses(for: "insight")
		#expect(ObjectMenuPlan.moveTargets(statuses: statuses, currentStatus: "elsewhere") == statuses)
	}

	@Test("a type with no statuses has nowhere to move a card")
	func moveTargetsNone() {
		#expect(ObjectMenuPlan.moveTargets(statuses: [], currentStatus: "todo").isEmpty)
	}
}
