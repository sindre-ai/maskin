import Foundation
import Testing

@testable import MaskinCore

private func approval(
	_ id: String, agent: String = "agent-1", type: String = "wiki_page", label: String = "Approve",
	rank: Int? = nil, destructive: Bool = false, drafts: [DecisionDraft] = []
) -> ForYouCard {
	ForYouCard(
		id: id, objectTitle: "Page \(id)", objectType: type, latestEventId: 10,
		mention: ForYouMention(
			eventId: 5, actorId: agent, content: "ask",
			decision: DecisionPrompt(
				title: "Publish \(id)?", summary: "1 page.", ask: "I cannot.",
				options: [
					DecisionOption(label: label, consequences: ["Goes live"], recommended: true, destructive: destructive),
					DecisionOption(label: "Hold", consequences: ["Waits"]),
				], drafts: drafts)),
		rank: rank)
}

private func entry(_ card: ForYouCard, _ bucket: FeedBucket = .needs) -> FeedEntry {
	FeedEntry(card: card, bucket: bucket)
}

private func items(_ entries: [FeedEntry], approved: Set<String> = []) -> [FeedItem] {
	ApprovalGrouping.items(entries: entries, approvedIds: approved, agentName: { _ in "Developer" })
}

struct ApprovalGroupsTests {
	@Test func threeOpenApprovalsFromOneAgentAndTypeFormOneGroup() {
		let thread = ForYouCard(id: "t", objectTitle: "Chat", objectType: "task", mention: ForYouMention(eventId: 1, content: "hi"))
		let result = items([
			entry(approval("a", rank: 0)), entry(approval("b", rank: 1)), entry(thread, .fyi),
			entry(approval("c", rank: 2)),
		])
		#expect(result.count == 1)
		guard case .group(let group) = result[0] else {
			Issue.record("expected a group")
			return
		}
		#expect(group.members.map(\.id) == ["a", "b", "c"])
		#expect(group.openCount == 3)
		#expect(group.agentName == "Developer")
	}

	@Test func aGroupSitsWhereItsFirstCardWas() {
		let other = approval("x", agent: "agent-2", type: "bet", rank: 0)
		let result = items([
			entry(other), entry(approval("a", rank: 1)), entry(approval("b", rank: 2)), entry(approval("c", rank: 3)),
		])
		#expect(result.map(\.id).first == "x")
		#expect(result.count == 2)
		if case .group = result[1] {} else { Issue.record("expected the group second") }
	}

	@Test func twoApprovalsStayOrdinaryCards() {
		let result = items([entry(approval("a")), entry(approval("b"))])
		#expect(result.count == 2)
		for item in result { if case .group = item { Issue.record("two cards must not group") } }
	}

	@Test func differentAgentsOrTypesNeverShareAGroup() {
		let mixed = [
			entry(approval("a")), entry(approval("b")), entry(approval("c", agent: "agent-2")),
			entry(approval("d", type: "bet")), entry(approval("e")),
		]
		let result = items(mixed)
		guard case .group(let group) = result.first else {
			Issue.record("expected a group first")
			return
		}
		#expect(Set(group.members.map(\.id)) == ["a", "b", "e"])
		#expect(result.count == 3)
	}

	@Test func onlyApproveOptionsThatCanBeUndoneAndCarryNoDraftGroup() {
		let draft = DecisionDraft(label: "Email", body: "Hello")
		let candidates = [
			entry(approval("a", label: "Publish")), entry(approval("b", label: "Publish")),
			entry(approval("c", label: "Publish")),
			entry(approval("d", destructive: true)), entry(approval("e", destructive: true)),
			entry(approval("f", destructive: true)),
			entry(approval("g", drafts: [draft])), entry(approval("h", drafts: [draft])),
			entry(approval("i", drafts: [draft])),
		]
		let result = items(candidates)
		#expect(result.count == candidates.count)
		for item in result { if case .group = item { Issue.record("none of these may group") } }
	}

	@Test func approveIsMatchedByItsFirstWord() {
		#expect(ApprovalGrouping.isApprove("Approve"))
		#expect(ApprovalGrouping.isApprove("approve and publish"))
		#expect(!ApprovalGrouping.isApprove("Approval needed"))
		#expect(!ApprovalGrouping.isApprove("Disapprove"))
	}

	@Test func differentApproveOptionsStaySeparate() {
		let result = items([
			entry(approval("a", label: "Approve")), entry(approval("b", label: "Approve")),
			entry(approval("c", label: "Approve and publish")),
		])
		#expect(result.count == 3)
	}

	@Test func approvedCardsStayInTheGroupAsRows() {
		let result = items(
			[entry(approval("a", rank: 0)), entry(approval("b", rank: 1), .done), entry(approval("c", rank: 2), .done)],
			approved: ["b", "c"])
		guard case .group(let group) = result.first else {
			Issue.record("expected a group")
			return
		}
		#expect(group.members.map(\.id) == ["a", "b", "c"])
		#expect(group.openCount == 1)
		#expect(group.approvedCount == 2)
		#expect(!group.isDone)
	}

	@Test func aFinishedGroupLeadsAndShowsItsDoneState() {
		let result = items(
			[entry(approval("x", agent: "agent-2", type: "bet")), entry(approval("a"), .done), entry(approval("b"), .done), entry(approval("c"), .done)],
			approved: ["a", "b", "c"])
		guard case .group(let group) = result.first else {
			Issue.record("expected the done group first")
			return
		}
		#expect(group.isDone)
		#expect(group.total == 3)
		#expect(result.count == 2)
	}

	@Test func aCardDecidedOutsideTheGroupDoesNotJoinIt() {
		let result = items([entry(approval("a")), entry(approval("b"), .done)], approved: [])
		#expect(result.count == 1)
	}

	@Test func titlesUseThePluralOfTheTypeName() {
		let group = ApprovalGroup(
			id: "g", agentName: nil, objectType: "wiki_page",
			members: ["a", "b", "c", "d", "e"].map { ApprovalGroup.Member(entry: entry(approval($0)), isApproved: false) })
		#expect(group.title(typeLabel: "Wiki page") == "Review 5 wiki pages")
		#expect(group.doneText(typeLabel: "Wiki page") == "5 wiki pages approved.")
	}

	@Test func pluralsFollowPlainEnglish() {
		#expect(ApprovalGrouping.plural("wiki page", count: 5) == "wiki pages")
		#expect(ApprovalGrouping.plural("policy", count: 3) == "policies")
		#expect(ApprovalGrouping.plural("key", count: 3) == "keys")
		#expect(ApprovalGrouping.plural("bonus", count: 3) == "bonuses")
		#expect(ApprovalGrouping.plural("page", count: 1) == "page")
	}
}

@MainActor
struct ApprovalGroupStoreTests {
	private func make() -> (ForYouStore, FakeForYouSource, FakeDecisionBackend) {
		let source = FakeForYouSource()
		let backend = FakeDecisionBackend()
		let outbox = Outbox(
			fileURL: temporaryOutboxFile(), executor: DecisionOutboxExecutor(backend: backend),
			network: ManualNetworkMonitor(), workspaceId: { "ws-1" }, backoff: { _ in 0.02 })
		let decisions = DecisionService(outbox: outbox, undoWindow: 0.1)
		let store = ForYouStore(
			source: source, decisions: decisions, workspaceId: { "ws-1" },
			defaults: UserDefaults(suiteName: "groups-\(UUID().uuidString)")!, eventDebounce: .milliseconds(10))
		return (store, source, backend)
	}

	private func group(in store: ForYouStore) -> ApprovalGroup? {
		for item in store.needsItems { if case .group(let group) = item { return group } }
		return nil
	}

	@Test func approveAllSendsOneAnswerPerCardThroughTheSinglePath() async {
		let (store, source, backend) = make()
		source.feed = .success(["a", "b", "c"].enumerated().map { approval($1, rank: $0) })
		await store.load()
		let before = group(in: store)
		#expect(before?.openCount == 3)
		let batch = store.approveAll(in: before!)
		#expect(batch.taken.count == 3)
		#expect(group(in: store)?.isDone == true)
		#expect(await eventually { backend.calls.filter { $0.hasPrefix("comment:") }.count == 3 })
		#expect(Set(backend.calls.filter { $0.hasPrefix("comment:") }) == [
			"comment:a:Approve:5", "comment:b:Approve:5", "comment:c:Approve:5",
		])
		// Past the Undo time nothing in the strip can be taken back; the cards are in Handled today.
		#expect(group(in: store) == nil)
	}

	@Test func approvingOneCardKeepsTheGroupAndCountsDown() async {
		let (store, source, _) = make()
		source.feed = .success(["a", "b", "c"].enumerated().map { approval($1, rank: $0) })
		await store.load()
		#expect(store.approveFromGroup(approval("a")))
		let after = group(in: store)
		#expect(after?.openCount == 2)
		#expect(after?.approvedCount == 1)
		#expect(after?.members.count == 3)
	}

	@Test func undoPutsEveryCardBackAndNothingWasSent() async {
		let (store, source, backend) = make()
		source.feed = .success(["a", "b", "c"].enumerated().map { approval($1, rank: $0) })
		await store.load()
		store.approveAll(in: group(in: store)!)
		let done = group(in: store)!
		#expect(store.canUndo(done))
		store.undo(done)
		#expect(group(in: store)?.openCount == 3)
		try? await Task.sleep(for: .milliseconds(300))
		#expect(backend.calls.isEmpty)
	}

	@Test func theSentenceIgnoresTheFilterAndNamesTheAgent() async {
		let (store, source, _) = make()
		source.feed = .success(["a", "b", "c"].enumerated().map { approval($1, rank: $0) })
		await store.load()
		#expect(store.blockedSummary == "Forge needs a call: Publish a?")
		store.options.intent = .questions
		#expect(store.blockedSummary == "Forge needs a call: Publish a?")
	}

	@Test func theDoneStripCountsOnlyWhatCanStillBeUndone() async {
		let (store, source, _) = make()
		source.feed = .success(["a", "b", "c"].enumerated().map { approval($1, rank: $0) })
		await store.load()
		store.approveFromGroup(approval("a"))
		try? await Task.sleep(for: .milliseconds(400))  // a is past its Undo time
		store.approveFromGroup(approval("b"))
		store.approveFromGroup(approval("c"))
		let done = group(in: store)
		#expect(done?.isDone == true)
		#expect(store.undoableCount(done!) == 2)
		store.undo(done!)
		#expect(group(in: store)?.approvedCount == 1)
	}

	@Test func theDoneStripClearsOnceNothingCanBeUndone() async {
		let (store, source, _) = make()
		source.feed = .success(["a", "b", "c"].enumerated().map { approval($1, rank: $0) })
		await store.load()
		store.approveAll(in: group(in: store)!)
		#expect(group(in: store)?.isDone == true)
		#expect(await eventually { group(in: store) == nil })
	}

	@Test func anEditNotYetSentTurnsTheCardsSendOptionOff() async {
		let (store, source, _) = make()
		let reviews = DraftReviewStore(remote: FakeReviewRemote(), undoWindow: 60, announce: { _ in true })
		store.reviews = reviews
		let preview = ObjectPreview(
			kind: "email", label: "Email", subject: "Following up", body: "Hi Mette", contentHash: "h")
		let card = ForYouCard(
			id: "card-1", objectTitle: "Follow up", objectType: "task", latestEventId: 10,
			mention: ForYouMention(
				eventId: 5, actorId: "agent-1", content: "ask",
				decision: DecisionPrompt(
					title: "Send it?", summary: "One email.", ask: "Send?",
					options: [DecisionOption(label: "Send", recommended: true), DecisionOption(label: "Hold")],
					draft: DecisionDraft(
						id: "mette", label: "Email to Mette", body: "Hi Mette", objectId: "o1", preview: preview))),
			rank: 0)
		source.feed = .success([card])
		await store.load()
		let draft = ReviewDraft.drafts(in: card, agentName: nil)[0]

		#expect(store.unsentEditNote(for: card) == nil)
		reviews.setBody("Changed", for: draft)
		#expect(store.unsentEditNote(for: card) == "Approve your edited message under Drafts to review")
		store.choose(DecisionOption(label: "Send", recommended: true), on: card)
		#expect(store.decisions.record(for: "card-1") == nil)  // the card's own Send does nothing
		#expect(store.takeSuggestedOptions().taken.isEmpty)
		reviews.revert(draft)
		#expect(store.unsentEditNote(for: card) == nil)

		reviews.setBody("Changed again", for: draft)
		reviews.approve(draft)
		#expect(store.unsentEditNote(for: card) == ForYouStore.sendingEditNote)
	}

	@Test func onlyTheOptionsThatSendTheMessageAreHeldBack() {
		#expect(ReviewDraft.sendsMessage(DecisionOption(label: "Send", recommended: true)))
		#expect(ReviewDraft.sendsMessage(DecisionOption(label: "Looks good", recommended: true)))
		#expect(ReviewDraft.sendsMessage(DecisionOption(label: "Send as is")))
		#expect(ReviewDraft.sendsMessage(DecisionOption(label: "Approve and post")))
		#expect(!ReviewDraft.sendsMessage(DecisionOption(label: "Hold")))
		#expect(!ReviewDraft.sendsMessage(DecisionOption(label: "Hold", recommended: true)))
		#expect(!ReviewDraft.sendsMessage(DecisionOption(label: "Don\u{2019}t send")))
		#expect(!ReviewDraft.sendsMessage(DecisionOption(label: "Skip")))
	}

	@Test func theSentenceSaysNothingIsBlockedOnAnEmptyFeed() async {
		let (store, _, _) = make()
		#expect(store.blockedSummary == nil)
		await store.load()
		#expect(store.blockedSummary == "Nothing is blocked on you.")
	}
}
