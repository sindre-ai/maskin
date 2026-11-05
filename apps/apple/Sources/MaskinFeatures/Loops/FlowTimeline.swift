import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A flow's timeline: the flow's own comments and events, the same thread the object page shows as
/// Activity (a flow is an object, so its channel is its timeline, not a separate room). One model
/// and two views, shared by the Flows detail Activity tab and the Team-side flow channel:
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
	/// For the placeholder: "Message {flow}". Nil reads "Message this flow".
	let flowName: String?
	let store: ObjectDetailStore
	let composer: ChatComposerModel
	/// The agent that drives the flow, when it has one. A flow's composer then offers "Message {owner}",
	/// which opens a chat with that agent; the comment path stays what it was, a comment on the flow.
	var owner: ChatParticipant?
	var mode: ObjectComposerMode = .comment
	/// The event a held-down Reply picked; the next comment threads under it.
	fileprivate(set) var replyingTo: TimelineItem?
	@ObservationIgnored private let events: EventHub?

	init(environment: AppEnvironment, flowID: String, flowName: String? = nil) {
		self.flowID = flowID
		self.flowName = flowName
		store = ObjectsServices(environment: environment).detailStore(for: flowID)
		composer = ChatComposerModel(
			uploader: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""),
			selfActorID: environment.auth.session?.actorId ?? "")
		events = environment.events
	}

	/// Loads the thread and follows live events until the surrounding task is cancelled.
	func start() async {
		await store.load()
		if let events { await store.observe(events.subscribe()) }
	}

	func startReply(to item: TimelineItem) {
		MaskinHaptics.play(.light)
		replyingTo = item
		composer.reply(to: store.authorName(for: item), text: ActivityGrouping.summary(of: item))
	}

	/// "Message {owner}" in message mode, "Comment on {flow}" otherwise. A flow with no driver agent has
	/// nobody to message, so the composer says what it does: it comments on the flow.
	private var defaultPlaceholder: String {
		Self.placeholder(ownerName: owner?.name, mode: mode, flowName: flowName)
	}

	static func placeholder(ownerName: String?, mode: ObjectComposerMode, flowName: String?) -> String {
		if let ownerName, mode == .message { return "Message \(ownerName)" }
		return "Comment on \(flowName ?? "this flow")"
	}

	var config: MaskinComposerConfig {
		MaskinComposerConfig(
			variant: .floating,
			placeholder: replyingTo.map { "Reply to \(store.authorName(for: $0))…" } ?? defaultPlaceholder,
			suggestions: { [store, composer] query in
				CommentMentions.candidates(
					query: query, actors: Array(store.directory.actors.values), selfID: store.currentActorId,
					excluding: Set(composer.mentions.map(\.id))
				).map { ChatParticipant(id: $0.id, name: $0.name, kind: $0.isAgent ? .agent : .human) }
			})
	}

	func send() {
		let text = composer.trimmedText
		guard !text.isEmpty, !composer.isUploading, !composer.hasFailedAttachment else { return }
		let mentions = composer.mentions.map(\.id).filter { $0 != store.currentActorId }
		let files = composer.attachments.compactMap(\.ref)
		let parent = replyingTo?.eventId
		composer.clear()
		replyingTo = nil
		Task { await store.postComment(text, mentions: mentions, attachments: files, parentEventId: parent) }
	}
}

/// The timeline itself, grouped by day with replies under their parents. Hold an event to reply;
/// tap an object a comment links to to open it.
struct FlowTimelineView: View {
	@Bindable var model: FlowTimelineModel
	var now: Date = Date()
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			ObjectActivityView(
				store: model.store, onOpenObject: { runtime?.openObject($0) },
				onReply: { model.startReply(to: $0) }, now: now)
		}
	}
}

/// The shared composer for a flow's timeline: pin it to the bottom from the host. With a driver agent
/// it offers "Comment | Message {owner}": message mode sends into the chat with that agent about this
/// flow (found or created through `AgentThreads`) and shows it in a sheet.
struct FlowTimelineComposer: View {
	let model: FlowTimelineModel
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var thread: FlowOwnerThread?
	@State private var isOpening = false
	@State private var notice: String?

	var body: some View {
		VStack(spacing: MaskinSpace.s4) {
			if let owner = model.owner, runtime != nil {
				ObjectComposerModeToggle(mode: Bindable(model).mode, agentName: owner.name)
			}
			MaskinComposer(model: model.composer, config: config, onSend: send)
		}
		.task { await runtime?.mentionRoster()?.load() }
		.onChange(of: model.composer.replyTo == nil) { _, cleared in
			if cleared { model.clearReply() }
		}
		.sheet(item: $thread) { thread in
			if let environment = runtime?.environment { FlowOwnerThreadSheet(environment: environment, thread: thread) }
		}
		.alert(
			"Couldn't message the owner", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(notice ?? "")
		}
	}

	/// The workspace roster, with roles, like every other composer's `@` list.
	var config: MaskinComposerConfig {
		var config = model.config
		config.roster = runtime?.mentionRoster()?.roster
		return config
	}

	private func send() {
		guard model.mode == .message, let owner = model.owner, let environment = runtime?.environment else {
			model.send()
			return
		}
		guard !isOpening, let (text, metadata) = model.composer.take() else { return }
		isOpening = true
		let conversations = ConversationsStore(
			api: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""), events: nil)
		let subject = model.flowName ?? "this flow"
		Task {
			defer { isOpening = false }
			do {
				let opened = try await AgentThreads.open(
					withAgent: owner.id, titled: AgentThreads.title(about: subject),
					alsoInvite: metadata?.mentions ?? [], conversations: conversations)
				model.mode = .comment
				thread = FlowOwnerThread(
					conversations: conversations, conversationID: opened.outcome.conversation.id,
					recipient: opened.recipient, text: text,
					metadata: opened.recipient.id.map { AgentThreads.tagging($0, in: metadata) } ?? metadata)
			} catch {
				// Give the words back rather than lose them.
				model.composer.text = text
				notice = error is AgentThreads.AgentNotFound
					? "\(owner.name) is no longer in this workspace." : "\(ChatStore.message(error))"
			}
		}
	}
}

/// The chat a flow's composer opened with the flow's owner, and the message it carries.
struct FlowOwnerThread: Identifiable {
	let conversations: ConversationsStore
	let conversationID: String
	let recipient: AgentThreads.Recipient
	let text: String
	let metadata: ChatSendMetadata?
	var id: String { conversationID }
}

/// The real conversation with the owner, in a sheet: the Chats thread and composer, with the message
/// that opened it sent once through the same queue as any chat send.
struct FlowOwnerThreadSheet: View {
	let environment: AppEnvironment
	let thread: FlowOwnerThread
	@Environment(\.dismiss) private var dismiss
	@State private var built: (chat: ChatStore, composer: ChatComposerModel)?

	var body: some View {
		NavigationStack {
			Group {
				if let built {
					ChatThreadView(store: built.chat, composer: built.composer, conversations: thread.conversations)
				} else {
					Color.clear
				}
			}
			.navigationTitle(thread.recipient.name)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
		.ambientBackground(showsBottom: false)
		.task {
			guard built == nil else { return }
			let source = APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
			let desk = ChiefOfStaffDesk(
				conversations: thread.conversations, uploader: source,
				selfActorID: environment.auth.session?.actorId ?? "")
			let chat = ChiefOfStaffSheet.makeChat(
				environment: environment, desk: desk, conversationID: thread.conversationID)
			let composer = ChatComposerModel(uploader: source, selfActorID: environment.auth.session?.actorId ?? "")
			built = (chat, composer)
			if chat.send(thread.text, metadata: thread.metadata) == nil { composer.text = thread.text }
		}
	}
}

extension FlowTimelineModel {
	func clearReply() { replyingTo = nil }
}
