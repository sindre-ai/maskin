import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A flow opened from the Team list (spec 7 §4, flow channel). A flow's channel is its timeline, so
/// the content is that timeline under the flow's name as a 24pt heading, nothing else. The nav bar
/// carries a centred flow name (tap it for the flow's own page), a status line only while agents
/// are running, up to three member avatars with the lead first, and a pin button. The composer is
/// the shared one, "Message {flow}".
struct FlowChannelScreen: View {
	let environment: AppEnvironment
	let store: ConversationsStore
	let room: TeamFlowRoom

	@State private var model: FlowTimelineModel?
	@State private var detail: LoopDetailStore?
	@State private var showDetail = false
	@State private var showMembers = false
	@Environment(\.horizontalSizeClass) private var sizeClass
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	/// Agents on the flow, the lead (first) leading. Names resolve through the workspace directory;
	/// an id that does not resolve is left out rather than shown.
	private var members: [ChatParticipant] {
		(room.loop?.agentIDs ?? []).compactMap { id in store.actors.first { $0.id == id }?.participant }
	}

	private var leadID: String? { members.first?.id }

	var body: some View {
		root
	}

	@ViewBuilder
	private var root: some View {
		if sizeClass == .regular {
			NavigationStack { chrome }
		} else {
			chrome
		}
	}

	/// The screen with its nav bar, destinations and alerts.
	private var chrome: some View {
		content
			.ambientBackground()
			.navigationTitle(room.name)
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
			#endif
			.backChevronOnly()
			.toolbar { toolbarContent }
			.navigationDestination(isPresented: $showDetail) { detailDestination }
			.task { await store.loadActors() }
			.onAppear { buildModelIfNeeded() }
			.alert(membersTitle, isPresented: $showMembers) { Button("OK", role: .cancel) {} }
	}

	private var membersTitle: String {
		ThreadNavAvatars.label(participants: members, leadID: leadID)
	}

	@ViewBuilder
	private var detailDestination: some View {
		if let detail { LoopDetailView(store: detail) }
	}

	private func buildModelIfNeeded() {
		if model == nil { model = FlowTimelineModel(environment: environment, flowID: room.id) }
	}

	@ViewBuilder
	private var content: some View {
		if let model {
			timeline(model)
		} else {
			Color.clear
		}
	}

	private func timeline(_ model: FlowTimelineModel) -> some View {
		ScrollView { timelineBody(model) }
			.scrollDismissesKeyboard(.interactively)
			.safeAreaInset(edge: .bottom, spacing: 0) { composerBar(model) }
			.task { await model.start() }
	}

	private func timelineBody(_ model: FlowTimelineModel) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			Text(room.name)
				.maskinText(.sheetTitle).foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.bottom, MaskinSpace.s10)
				.accessibilityAddTraits(.isHeader)
			FlowTimelineView(model: model)
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.top, MaskinSpace.s2)
		.padding(.bottom, MaskinSpace.s7)
	}

	private func composerBar(_ model: FlowTimelineModel) -> some View {
		composer(model)
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.bottom, MaskinSpace.s3)
	}

	private func composer(_ model: FlowTimelineModel) -> some View {
		let config: MaskinComposerConfig = composerConfig(model)
		let cleared: Bool = model.composer.replyTo == nil
		return MaskinComposer(model: model.composer, config: config, onSend: { model.send() })
			.onChange(of: cleared) { _, isCleared in
				if isCleared { model.clearReply() }
			}
	}

	private func composerConfig(_ model: FlowTimelineModel) -> MaskinComposerConfig {
		var config = model.config
		config.roster = runtime?.mentionRoster()?.roster
		if model.replyingTo == nil { config.placeholder = "Message \(room.name)" }
		return config
	}

	/// `▮ n working` only while agents run; a quiet flow shows no status line at all.
	private var status: ThreadNavStatus? {
		room.workingCount > 0 ? .live("▮ \(room.workingCount) working") : nil
	}

	private func openFlow() {
		guard let loop = room.loop else { return }
		let api = APILoopsSource(client: environment.client, workspaceID: environment.workspaceId ?? "")
		detail = LoopDetailStore(loop: loop, api: api, events: environment.events)
		showDetail = true
	}

	private var titleTap: (() -> Void)? {
		guard room.loop != nil else { return nil }
		return { openFlow() }
	}

	private var isPinned: Bool { store.pinnedFlowIDs.contains(room.id) }

	private func togglePin() {
		MaskinHaptics.play(.selection)
		store.setFlowPinned(room.id, !isPinned)
	}

	private var pinButton: some View {
		Button(action: togglePin) {
			Label(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.fill" : "pin")
		}
	}

	@ViewBuilder
	private var memberStack: some View {
		if !members.isEmpty {
			Button { showMembers = true } label: {
				ThreadNavAvatars(participants: members, leadID: leadID, limit: 3)
			}
			.buttonStyle(.maskinPressed)
		}
	}

	@ToolbarContentBuilder
	private var toolbarContent: some ToolbarContent {
		ToolbarItem(placement: .principal) {
			ThreadNavTitle(title: room.name, status: status, onTap: titleTap)
		}
		ToolbarItemGroup(placement: .primaryAction) {
			memberStack
			pinButton
		}
	}
}
