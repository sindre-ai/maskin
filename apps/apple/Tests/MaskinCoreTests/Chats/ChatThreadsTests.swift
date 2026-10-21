import Foundation
import Testing

@testable import MaskinCore

private func reply(_ id: Int, root: Int = 10, by actor: String = "relay", agent: Bool = true, also: Bool = false)
	-> ChatMessage
{
	var m = chatMsg(id, by: actor, name: actor.capitalized, agent: agent, "reply \(id)")
	m.threadRootID = root
	m.alsoInChannel = also
	return m
}

private func summary(count: Int, unread: Int, last: Int, people: [ChatParticipant] = [chatSam]) -> ThreadSummary {
	ThreadSummary(replyCount: count, unreadCount: unread, lastReplyID: last, participants: people)
}

@Suite("ThreadSummary")
struct ThreadSummaryTests {
	@Test("a root nobody replied to has no summary")
	func empty() {
		let s = ThreadSummary.current(
			base: nil, rootAuthor: chatSam, replies: [], currentActorID: "me", readThrough: nil)
		#expect(s == nil)
	}

	@Test("the server summary stands when nothing newer arrived")
	func baseOnly() {
		let base = summary(count: 3, unread: 2, last: 30)
		let s = ThreadSummary.current(
			base: base, rootAuthor: chatSam, replies: [reply(25), reply(30)], currentActorID: "me",
			readThrough: nil)
		#expect(s == base)
	}

	@Test("replies that arrived after the summary are added to the count and the unread count")
	func newerReplies() {
		let base = summary(count: 1, unread: 0, last: 20)
		let s = ThreadSummary.current(
			base: base, rootAuthor: chatSam, replies: [reply(20), reply(31), reply(32, by: "me", agent: false)],
			currentActorID: "me", readThrough: nil)
		#expect(s?.replyCount == 3)
		// My own reply is never unread.
		#expect(s?.unreadCount == 1)
		#expect(s?.lastReplyID == 32)
	}

	@Test("a thread with no server summary is built from the replies held")
	func noBase() {
		let s = ThreadSummary.current(
			base: nil, rootAuthor: chatSam, replies: [reply(11), reply(12)], currentActorID: "me",
			readThrough: nil)
		#expect(s?.replyCount == 2)
		#expect(s?.unreadCount == 2)
		#expect(s?.participants.map(\.id) == ["sam", "relay"])
	}

	@Test("opening the thread reads it, including replies the summary counted")
	func readThrough() {
		let base = summary(count: 2, unread: 2, last: 30)
		let s = ThreadSummary.current(
			base: base, rootAuthor: chatSam, replies: [reply(30)], currentActorID: "me", readThrough: 30)
		#expect(s?.unreadCount == 0)
		#expect(s?.replyCount == 2)
	}

	@Test("avatars stop at three people, root author first, nobody twice")
	func participantsCapped() {
		let s = ThreadSummary.current(
			base: nil, rootAuthor: chatSam,
			replies: [reply(11, by: "a"), reply(12, by: "a"), reply(13, by: "b"), reply(14, by: "c")],
			currentActorID: "me", readThrough: nil)
		#expect(s?.participants.map(\.id) == ["sam", "a", "b"])
	}

	@Test("labels say new replies when there are unread ones, the total otherwise")
	func labels() {
		#expect(ThreadSummary.label(count: 1, unread: 0) == "1 reply")
		#expect(ThreadSummary.label(count: 4, unread: 0) == "4 replies")
		#expect(ThreadSummary.label(count: 4, unread: 1) == "1 new reply")
		#expect(ThreadSummary.label(count: 4, unread: 3) == "3 new replies")
	}
}

@Suite("Thread list")
struct ThreadListTests {
	private func item(_ id: Int, unread: Int, at offset: TimeInterval) -> ThreadListItem {
		ThreadListItem(
			conversationID: "c1", conversationTitle: "Chat", root: chatMsg(id),
			summary: ThreadSummary(replyCount: 2, unreadCount: unread, lastReplyID: id + 1),
			lastReply: chatMsg(id + 1, by: "relay", name: "Relay", agent: true, "Done", at: offset))
	}

	@Test("unread threads come first, each section newest first")
	func sections() {
		let sections = ThreadListSections([
			item(1, unread: 0, at: 10), item(2, unread: 1, at: 5), item(3, unread: 0, at: 20),
			item(4, unread: 2, at: 8),
		])
		#expect(sections.new.map { $0.root.serverID } == [4, 2])
		#expect(sections.earlier.map { $0.root.serverID } == [3, 1])
		#expect(sections.unreadCount == 2)
		#expect(!sections.isEmpty)
	}

	@Test("the snippet names who spoke last")
	func snippet() {
		#expect(item(1, unread: 0, at: 1).snippet == "Relay: Done")
		let bare = ThreadListItem(
			conversationID: "c1", conversationTitle: "Chat", root: chatMsg(1, "first words"),
			summary: ThreadSummary(replyCount: 1, lastReplyID: 2), lastReply: nil)
		#expect(bare.snippet == "first words")
	}

	@Test("a reply is addressed to the root's author, then the chat's agents, never to you")
	func targets() {
		let people = [chatMe, chatRelay, chatSam]
		let toHuman = ThreadReplyTargets.candidates(rootAuthor: chatSam, participants: people, currentActorID: "me")
		#expect(toHuman.map(\.id) == ["sam", "relay"])
		let toAgent = ThreadReplyTargets.candidates(rootAuthor: chatRelay, participants: people, currentActorID: "me")
		#expect(toAgent.map(\.id) == ["relay"])
		let mine = ThreadReplyTargets.candidates(rootAuthor: chatMe, participants: people, currentActorID: "me")
		#expect(mine.map(\.id) == ["relay"])
	}
}

@Suite("ChatStore threads")
@MainActor
struct ChatStoreThreadTests {
	private func harness() -> ChatHarness {
		var root = chatMsg(10, by: "sam", name: "Sam", "The dry run finished")
		root.thread = summary(count: 1, unread: 1, last: 11)
		return ChatHarness(server: [chatMsg(9), root, reply(11, by: "sam", agent: false), chatMsg(12, "after")])
	}

	@Test("the timeline leaves thread replies out; allMessages and replies(to:) keep them")
	func timelineFilter() async {
		let h = harness()
		await h.store.start()
		#expect(h.store.messages.compactMap(\.serverID) == [9, 10, 12])
		#expect(h.store.allMessages.compactMap(\.serverID) == [9, 10, 11, 12])
		#expect(h.store.replies(to: 10).compactMap(\.serverID) == [11])
	}

	@Test("a reply also sent to the chat stays in the timeline")
	func alsoInChannel() async {
		let h = ChatHarness(server: [chatMsg(10), reply(11, by: "sam", agent: false, also: true)])
		await h.store.start()
		#expect(h.store.messages.compactMap(\.serverID) == [10, 11])
	}

	@Test("a thread reply shows in its thread at once, not in the timeline, and goes out under the root")
	func optimisticReply() async {
		let h = harness()
		await h.store.start()
		let id = h.store.reply("Keep Qualifier", in: 10, to: chatRelay, alsoInChannel: false)
		#expect(id != nil)
		#expect(h.store.replies(to: 10).last?.content == "Keep Qualifier")
		#expect(h.store.replies(to: 10).last?.status == .sending)
		#expect(!h.store.messages.contains { $0.content == "Keep Qualifier" })
		#expect(await h.settled())
		#expect(await h.api.sentThreads == [ChatSendThread(rootID: 10, alsoInChannel: false)])
		// The addressee is mentioned: that is what wakes an agent.
		#expect(await h.api.sentMetadata.last??.mentions == ["relay"])
		#expect(h.store.replies(to: 10).last?.serverID == 13)
		#expect(h.store.replies(to: 10).last?.id == id)
	}

	@Test("also send to chat puts the delivered reply in the timeline too")
	func alsoSend() async {
		let h = harness()
		await h.store.start()
		h.store.reply("Both places", in: 10, to: nil, alsoInChannel: true)
		#expect(await h.settled())
		#expect(h.store.messages.last?.content == "Both places")
		#expect(await h.api.sentThreads.last??.alsoInChannel == true)
	}

	@Test("the pill's summary counts replies that arrived after the root was fetched")
	func liveSummary() async {
		let h = harness()
		await h.store.start()
		let root = h.store.messages.first { $0.serverID == 10 }
		#expect(root.flatMap(h.store.threadSummary(for:))?.replyCount == 1)
		await h.api.append(reply(13, by: "relay"))
		await h.store.sync()
		let again = h.store.messages.first { $0.serverID == 10 }
		#expect(again.flatMap(h.store.threadSummary(for:))?.replyCount == 2)
		#expect(again.flatMap(h.store.threadSummary(for:))?.unreadCount == 2)
	}

	@Test("opening a thread marks it read here and tells the server once")
	func markRead() async {
		let h = harness()
		await h.store.start()
		await h.store.markThreadRead(10)
		await h.store.markThreadRead(10)
		let root = h.store.messages.first { $0.serverID == 10 }
		#expect(root.flatMap(h.store.threadSummary(for:))?.unreadCount == 0)
		let marks = await h.api.threadMarks
		#expect(marks.count == 1)
		#expect(marks.first?.root == 10 && marks.first?.last == 11)
	}

	@Test("loadThread brings in replies older than the page held")
	func loadsOlderReplies() async {
		var server: [ChatMessage] = [chatMsg(1, by: "sam", "root")]
		server.append(reply(2, root: 1))
		server += (3...60).map { chatMsg($0) }
		let h = ChatHarness(server: server, pageSize: 10)
		await h.store.start()
		#expect(h.store.replies(to: 1).isEmpty)
		await h.store.loadThread(1)
		#expect(h.store.replies(to: 1).compactMap(\.serverID) == [2])
	}

	@Test("a reply that failed to send keeps its thread so retry posts it there")
	func failedReplyKeepsThread() async {
		let h = harness()
		await h.api.failNextSends([ChatsHTTPError(status: 404, message: "gone")])
		await h.store.start()
		h.store.reply("lost", in: 10, to: nil, alsoInChannel: false)
		#expect(await eventually { h.store.replies(to: 10).last?.isFailed == true })
		let failed = h.store.replies(to: 10).last
		#expect(failed?.isFailed == true)
		#expect(failed?.threadRootID == 10)
		#expect(!h.store.messages.contains { $0.content == "lost" })
	}
}
