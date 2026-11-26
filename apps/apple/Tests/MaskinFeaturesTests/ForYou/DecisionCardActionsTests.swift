import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("DecisionCardActions")
struct DecisionCardActionsTests {
	private let ship = DecisionOption(label: "Ship", recommended: true)
	private let wait = DecisionOption(label: "Wait")
	private let hold = DecisionOption(label: "Hold for now")
	private let later = DecisionOption(label: "Later this week")
	private let sendAll = DecisionOption(label: "Send to all", recommended: true, destructive: true)

	private func prompt(_ options: [DecisionOption]) -> DecisionPrompt {
		DecisionPrompt(title: "Ship it", summary: "Ready.", ask: "Ship?", options: options)
	}

	private func card(_ options: [DecisionOption]?) -> ForYouCard {
		ForYouCard(
			id: "c", objectTitle: "Page", objectType: "task",
			mention: ForYouMention(eventId: 1, content: "ask", decision: options.map(prompt)))
	}

	@Test("the suggested option is the main button, the rest are pills")
	func primaryAndAlternates() {
		let decision = prompt([wait, ship, DecisionOption(label: "Skip")])
		#expect(DecisionCardActions.primaryOptions(of: decision) == [ship])
		#expect(DecisionCardActions.alternateOptions(of: decision).map(\.label) == ["Wait", "Skip"])
	}

	@Test("a Hold or a Later the agent wrote is not drawn as a pill")
	func holdAndLaterAreNotPills() {
		let decision = prompt([ship, hold, later, wait])
		#expect(DecisionCardActions.alternateOptions(of: decision) == [wait])
	}

	@Test("a Hold that is the suggested option is still the main button")
	func recommendedHoldStaysPrimary() {
		let suggested = DecisionOption(label: "Hold", recommended: true)
		#expect(DecisionCardActions.primaryOptions(of: prompt([suggested, wait])) == [suggested])
	}

	@Test("a card with no suggestion has no main button")
	func noSuggestion() {
		let decision = prompt([wait, DecisionOption(label: "Skip")])
		#expect(DecisionCardActions.primaryOptions(of: decision).isEmpty)
		#expect(DecisionCardActions.alternateOptions(of: decision).count == 2)
	}

	@Test("tapping an option that cannot be undone asks first, any other is taken at once")
	func tapDecision() {
		#expect(DecisionCardActions.tap(sendAll) == .confirmFirst)
		#expect(DecisionCardActions.tap(ship) == .choose)
		#expect(DecisionCardActions.tap(DecisionOption(label: "Delete", destructive: true)) == .confirmFirst)
	}

	@Test("an unsent edit holds back the options that would send, and only those")
	func heldBackByAnEdit() {
		let note = "Approve your edited message under Drafts to review"
		#expect(DecisionCardActions.isHeldBack(ship, unsentEditNote: note))
		#expect(DecisionCardActions.isHeldBack(DecisionOption(label: "Send as is"), unsentEditNote: note))
		#expect(!DecisionCardActions.isHeldBack(DecisionOption(label: "Hold", recommended: true), unsentEditNote: note))
		#expect(!DecisionCardActions.isHeldBack(wait, unsentEditNote: note))
	}

	@Test("without an unsent edit nothing is held back")
	func notHeldBackWithoutAnEdit() {
		#expect(!DecisionCardActions.isHeldBack(ship, unsentEditNote: nil))
	}

	@Test("swipe right takes the suggested option")
	func swipeTakes() {
		let swipe = DecisionCardActions.leadingSwipe(
			for: card([wait, ship]), answered: false, isHeldBack: { _ in false })
		#expect(swipe == .take(ship))
	}

	@Test("swipe right never takes an option that cannot be undone")
	func swipeSkipsDestructive() {
		let swipe = DecisionCardActions.leadingSwipe(
			for: card([sendAll, wait]), answered: false, isHeldBack: { _ in false })
		#expect(swipe == nil)
	}

	@Test("swipe right does not take a send that an unsent edit holds back")
	func swipeSkipsHeldBack() {
		let swipe = DecisionCardActions.leadingSwipe(
			for: card([ship, wait]), answered: false, isHeldBack: { $0 == ship })
		#expect(swipe == nil)
	}

	@Test("a mention with no options swipes to Done")
	func swipeDoneForAThread() {
		let swipe = DecisionCardActions.leadingSwipe(
			for: card(nil), answered: false, isHeldBack: { _ in false })
		#expect(swipe == .done)
	}

	@Test("a decision with no suggestion has no swipe")
	func swipeNothingWithoutASuggestion() {
		let swipe = DecisionCardActions.leadingSwipe(
			for: card([wait]), answered: false, isHeldBack: { _ in false })
		#expect(swipe == nil)
	}

	@Test("an answered card has no swipe")
	func swipeNothingOnceAnswered() {
		#expect(
			DecisionCardActions.leadingSwipe(
				for: card([ship]), answered: true, isHeldBack: { _ in false }) == nil)
		#expect(
			DecisionCardActions.leadingSwipe(
				for: card(nil), answered: true, isHeldBack: { _ in false }) == nil)
	}
}

@Suite("DraftStackRules")
struct DraftStackRulesTests {
	private func preview(_ delivery: ObjectPreview.Delivery?) -> ObjectPreview {
		ObjectPreview(kind: "email", label: "Email", body: "Hi", contentHash: "h", delivery: delivery)
	}

	private func draft(
		_ id: String?, to: String? = "Dan", delivery: ObjectPreview.Delivery? = .draft
	) -> DecisionDraft {
		DecisionDraft(id: id, label: "LinkedIn DM", to: to, body: "Hi", objectId: "o", preview: preview(delivery))
	}

	private let file = DecisionDraft(
		id: "f", label: "Page", body: "",
		file: FileReference(id: "f1", name: "page.html", mimeType: "text/html", sizeBytes: 10))

	@Test("a message offers Send and Skip unless it is a file or already approved or sent")
	func offersActions() {
		let rules = DraftStackRules(drafts: [])
		#expect(rules.offersActions(draft("a")))
		#expect(rules.offersActions(draft("a", delivery: nil)))
		#expect(!rules.offersActions(draft("a", delivery: .approved)))
		#expect(!rules.offersActions(draft("a", delivery: .sent)))
		#expect(!rules.offersActions(file))
	}

	@Test("a message is named by who it goes to, else by its kind")
	func name() {
		let rules = DraftStackRules(drafts: [])
		#expect(rules.name(draft("a", to: "Kenneth")) == "Kenneth")
		#expect(rules.name(draft("a", to: "  ")) == "LinkedIn DM")
		#expect(rules.name(draft("a", to: nil)) == "LinkedIn DM")
	}

	@Test("a message is settled under the agent's id, else its position")
	func key() {
		let rules = DraftStackRules(drafts: [])
		#expect(rules.key(draft("kenneth"), 3) == "kenneth")
		#expect(rules.key(draft(nil), 3) == "3")
	}

	@Test("Send all and Skip all act on the open messages only, with their positions")
	func pending() {
		let drafts = [draft("a"), draft("b", delivery: .sent), draft("c"), file, draft(nil)]
		let rules = DraftStackRules(drafts: drafts)
		#expect(rules.pending(done: [:]).map(\.index) == [0, 2, 4])
		#expect(rules.pending(done: ["a": .skip, "4": .send]).map(\.index) == [2])
	}

	@Test("the receipt says what was done and to whom")
	func receipt() {
		let rules = DraftStackRules(drafts: [])
		#expect(rules.receipt(draft("a", to: "Kenneth"), outcome: .send) == "Told the agent to send \u{00B7} Kenneth")
		#expect(rules.receipt(draft("a", to: nil), outcome: .skip) == "Skipped \u{00B7} LinkedIn DM")
	}

	@Test("the card settles when the last open message is dealt with, not before")
	func allSettled() {
		let rules = DraftStackRules(drafts: [draft("a"), draft("b"), draft("c", delivery: .sent), file])
		#expect(!rules.allSettled(done: [:]))
		#expect(!rules.allSettled(done: ["a": .send]))
		#expect(rules.allSettled(done: ["a": .send, "b": .skip]))
	}
}
