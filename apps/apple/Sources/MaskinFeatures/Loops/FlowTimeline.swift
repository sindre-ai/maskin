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

	var config: MaskinComposerConfig {
		MaskinComposerConfig(
			variant: .floating,
			placeholder: replyingTo.map { "Reply to \(store.authorName(for: $0))…" } ?? "Message \(flowName ?? "this flow")",
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

/// The shared composer for a flow's timeline: pin it to the bottom from the host.
struct FlowTimelineComposer: View {
	let model: FlowTimelineModel
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		MaskinComposer(model: model.composer, config: config, onSend: { model.send() })
			.task { await runtime?.mentionRoster()?.load() }
			.onChange(of: model.composer.replyTo == nil) { _, cleared in
				if cleared { model.clearReply() }
			}
	}
}

extension FlowTimelineComposer {
	/// The workspace roster, with roles, like every other composer's `@` list.
	var config: MaskinComposerConfig {
		var config = model.config
		config.roster = runtime?.mentionRoster()?.roster
		return config
	}
}

extension FlowTimelineModel {
	func clearReply() { replyingTo = nil }
}
