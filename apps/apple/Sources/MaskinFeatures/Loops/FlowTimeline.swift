import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A flow's room: one thread where people and agents talk, with the flow's own comments and events
/// merged in by time (events as quiet lines). The messages are the flow's chat; the comments and
/// events are the same ones the object page shows as Activity. One model and two views, shared by
/// the Flows detail Room tab and the Team-side flow channel:
///
/// ```swift
/// let model = FlowTimelineModel(environment: environment, flowID: id)
/// ScrollView { FlowTimelineView(model: model) }
///     .safeAreaInset(edge: .bottom) { FlowTimelineComposer(model: model).padding(.horizontal, MaskinSpace.s7) }
///     .task { await model.start() }
/// ```
@MainActor
@Observable
final class FlowTimelineModel {
	let flowID: String
	/// The title of the flow's chat when this composer starts it. Nil reads "Flow".
	let flowName: String?
	let store: ObjectDetailStore
	let composer: ChatComposerModel
	/// The agent that drives the flow, when it has one. It is the one agent invited when the room is
	/// started by the first message.
	var owner: ChatParticipant?
	/// The event a held-down Reply picked; the next comment threads under it.
	fileprivate(set) var replyingTo: TimelineItem?
	/// The flow's chat, once it exists. Nil until it is found or the first message creates it.
	private(set) var room: ChatStore?
	/// Why the last message did not go, for an alert.
	var notice: String?
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private let environment: AppEnvironment
	@ObservationIgnored private let chats: APIChatsSource
	@ObservationIgnored private var isOpeningRoom = false
	@ObservationIgnored private var roomVisible = false

	init(environment: AppEnvironment, flowID: String, flowName: String? = nil) {
		self.flowID = flowID
		self.flowName = flowName
		store = ObjectsServices(environment: environment).detailStore(for: flowID)
		let chats = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
		composer = ChatComposerModel(uploader: chats, selfActorID: environment.auth.session?.actorId ?? "")
		self.chats = chats
		self.environment = environment
		events = environment.events
	}

	/// Loads the comments and events, finds the chat, and follows live events until the surrounding
	/// task is cancelled.
	func start() async {
		let roomTask = Task { await startRoom() }
		await store.load()
		if let events { await store.observe(events.subscribe()) }
		roomTask.cancel()
		await roomTask.value
		room?.stop()
	}

	private func startRoom() async {
		if room == nil, let found = try? await FlowRoom.find(flowID: flowID, api: chats) { adopt(found) }
		await room?.start()
	}

	@discardableResult
	private func adopt(_ conversation: ConversationSummary) -> ChatStore {
		if let room { return room }
		let session = environment.auth.session
		let chat = ChatStore(
			conversationID: conversation.id, currentActorID: session?.actorId ?? "",
			currentActorName: session?.name ?? "You", api: chats,
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache)
		chat.isActive = roomVisible
		room = chat
		return chat
	}

	/// The room is on screen and the app is active: only then does the chat count as read. Events
	/// and old comments are not part of the chat, so they never make it unread.
	func setRoomVisible(_ visible: Bool) {
		roomVisible = visible
		room?.isActive = visible
	}

	/// The flow's comments, events and chat messages in one list.
	var items: [TimelineItem] {
		FlowRoom.merged(timeline: store.timeline, messages: room?.messages ?? [])
	}

	func startReply(to item: TimelineItem) {
		MaskinHaptics.play(.light)
		replyingTo = item
		composer.reply(to: store.authorName(for: item), text: ActivityGrouping.summary(of: item))
	}

	/// Retry a room message that did not go. False for anything else, which the page handles.
	func retry(_ item: TimelineItem) -> Bool {
		guard let id = FlowRoom.messageID(fromItemID: item.id) else { return false }
		room?.retrySend(id)
		return true
	}

	func discard(_ item: TimelineItem) -> Bool {
		guard let id = FlowRoom.messageID(fromItemID: item.id) else { return false }
		room?.discard(id)
		return true
	}

	var config: MaskinComposerConfig {
		MaskinComposerConfig(
			variant: .floating,
			placeholder: replyingTo.map { "Reply to \(store.authorName(for: $0))…" } ?? FlowRoom.placeholder,
			suggestions: { [store, composer] query in
				CommentMentions.candidates(
					query: query, actors: Array(store.directory.actors.values), selfID: store.currentActorId,
					excluding: Set(composer.mentions.map(\.id))
				).map { ChatParticipant(id: $0.id, name: $0.name, kind: $0.isAgent ? .agent : .human) }
			})
	}

	/// A message to the room, or a comment when a held-down Reply picked an old comment (decisions
	/// and asks stay comments).
	func send() {
		if replyingTo != nil { sendComment() } else { sendMessage() }
	}

	private func sendComment() {
		let text = composer.trimmedText
		guard !text.isEmpty, !composer.isUploading, !composer.hasFailedAttachment else { return }
		let mentions = composer.mentions.map(\.id).filter { $0 != store.currentActorId }
		let files = composer.attachments.compactMap(\.ref)
		let parent = replyingTo?.eventId
		composer.clear()
		replyingTo = nil
		Task { await store.postComment(text, mentions: mentions, attachments: files, parentEventId: parent) }
	}

	private func sendMessage() {
		guard !isOpeningRoom, let (text, metadata) = composer.take() else { return }
		if let room {
			if room.send(text, metadata: metadata) == nil { giveBack(text, reason: room.notice) }
			return
		}
		if SecretScanner.firstSecret(in: text) != nil {
			giveBack(text, reason: ChatsHTTPError.rawSecretMessage)
			return
		}
		isOpeningRoom = true
		Task {
			defer { isOpeningRoom = false }
			do {
				// Someone may have started the room since this page loaded; ask before making one.
				if let existing = try await FlowRoom.find(flowID: flowID, api: chats) {
					let chat = adopt(existing)
					await chat.start()
					if chat.send(text, metadata: metadata) == nil { giveBack(text, reason: chat.notice) }
					return
				}
				let created = try await chats.createFlowRoom(
					flowID: flowID, title: flowName ?? "Flow", participantIDs: owner.map { [$0.id] } ?? [],
					initialMessage: text, initialMetadata: metadata, idempotencyKey: IdempotencyKey.make())
				await adopt(created).start()
			} catch {
				giveBack(text, reason: ChatStore.message(error))
			}
		}
	}

	/// Put the words back in the composer rather than lose them.
	private func giveBack(_ text: String, reason: String?) {
		composer.text = text
		notice = reason ?? "Couldn't send that message."
	}
}

/// The room itself, grouped by day with replies under their parents. Hold a comment to reply; tap an
/// object a comment links to to open it. Showing it marks the flow's chat read.
struct FlowTimelineView: View {
	@Bindable var model: FlowTimelineModel
	var now: Date = Date()
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.scenePhase) private var scenePhase

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			ObjectActivityView(
				store: model.store, onOpenObject: { runtime?.openObject($0) },
				onReply: { model.startReply(to: $0) }, now: now, items: model.items,
				emptyState: (title: FlowRoom.emptyTitle, body: FlowRoom.emptyBody),
				onRetry: { model.retry($0) }, onDiscard: { model.discard($0) })
		}
		.onAppear { model.setRoomVisible(scenePhase == .active) }
		.onDisappear { model.setRoomVisible(false) }
		.onChange(of: scenePhase) { _, phase in model.setRoomVisible(phase == .active) }
	}
}

/// The shared composer for a flow's room: pin it to the bottom from the host. It sends a message to
/// the flow's chat, or a comment while a held-down Reply is open.
struct FlowTimelineComposer: View {
	let model: FlowTimelineModel
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		MaskinComposer(model: model.composer, config: config, onSend: { model.send() })
			.task { await runtime?.mentionRoster()?.load() }
			.onChange(of: model.composer.replyTo == nil) { _, cleared in
				if cleared { model.clearReply() }
			}
			.flowNoticeAlert(model)
	}

	/// The workspace roster, with roles, like every other composer's `@` list.
	var config: MaskinComposerConfig {
		var config = model.config
		config.roster = runtime?.mentionRoster()?.roster
		return config
	}
}

extension View {
	/// "Couldn't send" with the reason a room message did not go.
	func flowNoticeAlert(_ model: FlowTimelineModel) -> some View {
		alert(
			"Couldn't send",
			isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(model.notice ?? "")
		}
	}
}

extension FlowTimelineModel {
	func clearReply() { replyingTo = nil }
}
