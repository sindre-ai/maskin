import Foundation
import Testing

@testable import MaskinCore

@Suite("Composer slot") struct ComposerTrailingSlotTests {
	@Test func anEmptyFieldShowsTheMic() {
		#expect(ComposerTrailingSlot.resolve(hasContent: false, isBusy: false) == .mic)
	}

	@Test func textOrAnAttachmentShowsSend() {
		#expect(ComposerTrailingSlot.resolve(hasContent: true, isBusy: false) == .send)
	}

	@Test func aBusyAgentWithAnEmptyFieldShowsStop() {
		#expect(ComposerTrailingSlot.resolve(hasContent: false, isBusy: true) == .stop)
	}

	@Test func typingWhileBusyBringsSendBack() {
		#expect(ComposerTrailingSlot.resolve(hasContent: true, isBusy: true) == .send)
	}

	@Test func withoutDictationAnEmptyFieldKeepsSend() {
		#expect(ComposerTrailingSlot.resolve(hasContent: false, isBusy: false, canDictate: false) == .send)
	}
}

@Suite("Quick replies") struct QuickRepliesTests {
	private func message(_ text: String, actor: String = "them", status: ChatMessage.Status = .sent) -> ChatMessage {
		ChatMessage(
			id: "m", serverID: 1, conversationID: "c", actorID: actor, actorName: "Forge", author: .agent,
			content: text, status: status)
	}

	private func options(_ text: String, actor: String = "them", empty: Bool = true, typing: Bool = false) -> [String] {
		QuickReplies.options(
			after: message(text, actor: actor), currentActorID: "me", composerIsEmpty: empty,
			someoneIsTyping: typing)
	}

	@Test func shouldIAsksOfferGoAheadOrHoldOff() {
		#expect(options("Should I merge the PR?") == QuickReplies.shouldI)
		#expect(options("Done with the draft. Want me to send it?") == QuickReplies.shouldI)
	}

	@Test func canYouAsksOfferAbility() {
		#expect(options("Can you review this today?") == QuickReplies.canYou)
	}

	@Test func whenAsksOfferDays() {
		#expect(options("When should we ship?") == QuickReplies.when)
	}

	@Test func anyOtherQuestionOffersYesNoTellMeMore() {
		#expect(options("Is the budget approved?") == QuickReplies.other)
	}

	@Test func aStatementOffersNothing() {
		#expect(options("The PR is merged.").isEmpty)
	}

	@Test func onlyTheEndingSentenceDecides() {
		#expect(options("Should I merge it? It is green.").isEmpty)
	}

	@Test func nothingForYourOwnMessageATypingAgentOrAFilledComposer() {
		#expect(options("Should I merge?", actor: "me").isEmpty)
		#expect(options("Should I merge?", typing: true).isEmpty)
		#expect(options("Should I merge?", empty: false).isEmpty)
	}

	@Test func nothingForAFailedMessage() {
		let failed = message("Should I merge?", status: .failed("offline"))
		let result = QuickReplies.options(
			after: failed, currentActorID: "me", composerIsEmpty: true, someoneIsTyping: false)
		#expect(result.isEmpty)
	}
}

@Suite("Outgoing status") struct OutgoingStatusTests {
	private func mine(_ id: Int, status: ChatMessage.Status = .sent) -> ChatMessage {
		ChatMessage(
			id: "m\(id)", serverID: id, conversationID: "c", actorID: "me", actorName: "Me", author: .human,
			content: "hi", status: status)
	}

	private func agent(_ id: Int) -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "c", actorID: "forge", actorName: "Forge", author: .agent, content: "hello")
	}

	@Test func theStatusSitsUnderYourLatestMessageOnly() {
		let thread = [mine(1), agent(2), mine(3)]
		#expect(OutgoingStatus.latestOwnID(in: thread, currentActorID: "me") == "m3")
	}

	@Test func sentUntilAnAgentReplies() {
		#expect(OutgoingStatus.state(of: "m1", in: [mine(1)], currentActorID: "me") == .sent)
	}

	@Test func readOnceAnAgentHasPostedAfterIt() {
		let state = OutgoingStatus.state(of: "m1", in: [mine(1), agent(2)], currentActorID: "me")
		#expect(state == .read(by: "Forge"))
	}

	@Test func anAgentMessageBeforeYoursDoesNotCount() {
		#expect(OutgoingStatus.state(of: "m2", in: [agent(1), mine(2)], currentActorID: "me") == .sent)
	}

	@Test func sendingQueuedAndFailedFollowTheMessage() {
		#expect(OutgoingStatus.state(of: "m1", in: [mine(1, status: .sending)], currentActorID: "me") == .sending)
		#expect(
			OutgoingStatus.state(of: "m1", in: [mine(1, status: .waiting("offline"))], currentActorID: "me")
				== .queued("offline"))
		#expect(
			OutgoingStatus.state(of: "m1", in: [mine(1, status: .failed("x"))], currentActorID: "me") == .failed("x"))
	}

	@Test func theTextMatchesTheDesign() {
		#expect(OutgoingStatus.sending.text() == "Sending…")
		#expect(OutgoingStatus.sent.text() == "Sent")
		#expect(OutgoingStatus.sent.text(time: "9:41 AM") == "9:41 AM · Sent")
		#expect(OutgoingStatus.read(by: "Forge").text(time: "9:41 AM") == "9:41 AM · Read by Forge")
		#expect(OutgoingStatus.failed("offline").text() == "Not sent · Tap to retry")
	}
}

@Suite("Composer placeholder") struct ComposerPlaceholderTests {
	private let me = ChatParticipant(id: "me", name: "Sebastian Krumhausen", kind: .human)
	private let forge = ChatParticipant(id: "f", name: "Forge", kind: .agent)
	private let ida = ChatParticipant(id: "i", name: "Ida Berg", kind: .human)
	private let cpo = ChatParticipant(id: "c", name: "Chief Product Officer", kind: .agent)

	@Test func namesTheOtherSide() {
		#expect(ComposerPlaceholder.message(to: [me, forge], selfID: "me") == "Message Forge")
	}

	@Test func peopleGoByFirstNameAndAgentsByFullName() {
		#expect(ComposerPlaceholder.message(to: [me, ida, cpo], selfID: "me") == "Message Ida, Chief Product Officer")
	}

	@Test func pastTwoItCountsTheRest() {
		#expect(ComposerPlaceholder.message(to: [me, ida, forge, cpo], selfID: "me") == "Message Ida, Forge +1")
	}
}

@Suite("Swipe to reply") struct SwipeReplyTests {
	@Test func theBubbleFollowsAt70PercentAndStopsAt84() {
		#expect(SwipeReply.offset(forDrag: 40) == 28)
		#expect(SwipeReply.offset(forDrag: 400) == 84)
		#expect(SwipeReply.offset(forDrag: -30) == 0)
	}

	@Test func thresholdIs56() {
		#expect(!SwipeReply.reachesThreshold(offset: SwipeReply.offset(forDrag: 79)))
		#expect(SwipeReply.reachesThreshold(offset: SwipeReply.offset(forDrag: 81)))
	}

	@Test func aMostlyVerticalDragIsAScroll() {
		#expect(!SwipeReply.isReplySwipe(dx: 30, dy: 40))
		#expect(!SwipeReply.isReplySwipe(dx: -60, dy: 2))
		#expect(SwipeReply.isReplySwipe(dx: 60, dy: 8))
	}
}

@Suite("Conversation chips and pinned order") struct ConversationChipTests {
	private let human = ChatParticipant(id: "h", name: "Ida", kind: .human)
	private let agent = ChatParticipant(id: "a", name: "Forge", kind: .agent)
	private let other = ChatParticipant(id: "o", name: "Sam", kind: .human)
	private let me = ChatParticipant(id: "me", name: "Me", kind: .human)

	private func convo(_ id: String, _ people: [ChatParticipant], unread: Int = 0, pinned: Bool = false)
		-> ConversationSummary
	{
		ConversationSummary(id: id, title: id, pinned: pinned, unreadCount: unread, participants: people)
	}

	private var all: [ConversationSummary] {
		[
			convo("dm-person", [me, human], unread: 2), convo("dm-agent", [me, agent]),
			convo("group", [me, human, agent, other]),
		]
	}

	@Test func eachChipKeepsItsKind() {
		func ids(_ chip: ConversationChip) -> [String] {
			chip.apply(to: all, currentActorID: "me").map(\.id)
		}
		#expect(ids(.all) == ["dm-person", "dm-agent", "group"])
		#expect(ids(.unread) == ["dm-person"])
		#expect(ids(.people) == ["dm-person"])
		#expect(ids(.agents) == ["dm-agent"])
		#expect(ids(.groups) == ["group"])
	}

	@Test func pinnedOrderFollowsTheSavedIdsAndAppendsNewOnes() {
		let pinned = [convo("a", [me]), convo("b", [me]), convo("c", [me])]
		#expect(PinnedOrder.apply(["c", "gone", "a"], to: pinned).map(\.id) == ["c", "a", "b"])
		#expect(PinnedOrder.apply([], to: pinned).map(\.id) == ["a", "b", "c"])
	}

	@Test func droppingATileOnAnotherSwapsThem() {
		#expect(PinnedOrder.swap(["a", "b", "c"], moving: "a", onto: "c") == ["c", "b", "a"])
		#expect(PinnedOrder.swap(["a", "b"], moving: "a", onto: "a") == ["a", "b"])
		#expect(PinnedOrder.swap(["a", "b"], moving: "x", onto: "a") == ["a", "b"])
	}

	@Test func theOrderIsKeptPerUser() {
		let defaults = UserDefaults(suiteName: "chat.pinned.\(UUID().uuidString)")!
		let store = PinnedOrderStore(workspaceID: "w", actorID: "me", defaults: defaults)
		let other = PinnedOrderStore(workspaceID: "w", actorID: "you", defaults: defaults)
		store.save(["b", "a"])
		#expect(store.ids == ["b", "a"])
		#expect(other.ids.isEmpty)
	}
}

@MainActor
@Suite("Composer reply and edit") struct ComposerQuoteTests {
	private func model(_ text: String = "") -> ChatComposerModel {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		model.text = text
		return model
	}

	@Test func aReplyShowsAStripAndRidesInTheMessage() {
		let m = model("Agreed")
		m.beginReply(author: "Forge", content: "Ship it on Friday?")
		#expect(m.quote?.label == "Replying to Forge")
		let taken = m.take()
		#expect(taken?.text.hasPrefix("> **Forge**\n> Ship it on Friday?") == true)
		#expect(taken?.text.hasSuffix("Agreed") == true)
		#expect(m.quote == nil)
	}

	@Test func aReplyToNothingQuotedIsIgnored() {
		let m = model()
		m.beginReply(author: "Forge", content: "  \n ")
		#expect(m.quote == nil)
	}

	@Test func anEditLoadsTheWordsAndSaysSo() {
		let m = model()
		m.beginEdit(messageID: "m7", text: "Draft v1")
		#expect(m.text == "Draft v1")
		#expect(m.quote?.label == "Editing message")
		// An edit is not a send: `take()` stays closed so it can't post a duplicate.
		#expect(m.take() == nil)
		m.text = "Draft v2"
		let edit = m.takeEdit()
		#expect(edit?.messageID == "m7")
		#expect(edit?.text == "Draft v2")
		#expect(m.text.isEmpty)
		#expect(m.quote == nil)
	}

	@Test func cancellingAnEditEmptiesTheField() {
		let m = model()
		m.beginEdit(messageID: "m7", text: "Draft v1")
		m.cancelQuote()
		#expect(m.text.isEmpty)
		#expect(m.quote == nil)
	}

	@Test func cancellingAReplyKeepsWhatYouTyped() {
		let m = model("typed")
		m.beginReply(author: "Forge", content: "Hi")
		m.cancelQuote()
		#expect(m.text == "typed")
	}

	@Test func hasContentCountsTextAndAttachments() {
		let m = model()
		#expect(!m.hasContent)
		m.text = "x"
		#expect(m.hasContent)
	}
}
