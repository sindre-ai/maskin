import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One loop (v19): status and stage, then the Overview, any custom views, Performance, Briefings,
/// Items, Activity and Setup tabs, with the flow's composer pinned at the bottom.
struct LoopDetailView: View {
	let store: LoopDetailStore
	var install: LoopInstall?
	var onOpenTrigger: (String) -> Void = { _ in }

	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var confirmDelete = false
	@State private var timeline: FlowTimelineModel?

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				LoopDetailContent(
					store: store, install: install, timeline: timeline,
					onOpenTrigger: onOpenTrigger, setupFooter: AnyView(manage))
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 720, alignment: .leading)
			.frame(maxWidth: .infinity)
		}
		.ambientBackground()
		.navigationTitle("")
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.refreshable { await store.refresh() }
		.safeAreaInset(edge: .bottom, spacing: 0) {
			if let timeline {
				FlowTimelineComposer(model: timeline)
					.padding(.horizontal, MaskinSpace.s7)
					.padding(.bottom, MaskinSpace.s3)
			}
		}
		.confirmationDialog(
			"Delete this flow?", isPresented: $confirmDelete, titleVisibility: .visible
		) {
			Button("Delete flow", role: .destructive) { Task { await store.delete() } }
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("Its agents and triggers stay. This can't be undone.")
		}
		.task { await store.start() }
		.task {
			if timeline == nil, let environment = runtime?.environment {
				timeline = FlowTimelineModel(environment: environment, flowID: store.loop.id, flowName: store.loop.displayName)
			}
			await timeline?.start()
		}
		// The composer messages the flow's driver once the overview says who it is.
		.onChange(of: store.driver?.id, initial: true) {
			timeline?.owner = store.driver.map { ChatParticipant(id: $0.id, name: $0.name, kind: .agent) }
		}
		.onChange(of: timeline != nil) {
			timeline?.owner = store.driver.map { ChatParticipant(id: $0.id, name: $0.name, kind: .agent) }
		}
		// The loop's briefing cards come from the store For you shares; load it if nothing has yet.
		.task {
			if let stories = runtime?.storiesStore(), !stories.hasLoaded { await stories.load() }
		}
		.onDisappear { store.stop() }
	}

	/// At the foot of Setup: pause or resume, change the flow in chat, delete it.
	private var manage: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Manage")
			VStack(spacing: 0) {
				if store.loop.status != .draft {
					manageRow(
						store.loop.isPaused ? "Resume flow" : "Pause flow",
						symbol: store.loop.isPaused ? "play.fill" : "pause.fill"
					) { Task { await store.togglePause() } }
						.disabled(store.isTogglingPause)
					Divider().overlay(MaskinSurface.separator)
				}
				manageRow("Change in chat", symbol: "bubble.left") {
					runtime?.buildInChat("I'd like to change the flow \(store.loop.displayName). ")
				}
				Divider().overlay(MaskinSurface.separator)
				manageRow("Delete flow", symbol: "trash", destructive: true) { confirmDelete = true }
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		}
	}

	private func manageRow(
		_ title: String, symbol: String, destructive: Bool = false, action: @escaping () -> Void
	) -> some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s7) {
				Image(systemName: symbol).frame(width: MaskinSpace.s11)
				Text(title).maskinText(.body)
				Spacer(minLength: 0)
			}
			.foregroundStyle(destructive ? MaskinColor.destructive : MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: 44)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
	}
}

/// The loop page's tabs. Each custom view pinned to the loop is a tab of its own, right after
/// Overview, named by whoever pinned it (same order and names as the web loop page).
enum LoopDetailTab: Hashable, Identifiable {
	case overview, performance, briefings, items, activity, setup
	/// The index keeps two views that share a name apart.
	case view(index: Int, LoopView)

	var id: String {
		switch self {
		case .overview: "overview"
		case .performance: "performance"
		case .briefings: "briefings"
		case .items: "items"
		case .activity: "activity"
		case .setup: "setup"
		case .view(let index, let view): "view-\(index)-\(view.fileID)"
		}
	}

	var title: String {
		switch self {
		case .overview: "Overview"
		case .performance: "Performance"
		case .briefings: "Briefings"
		case .items: "Items"
		case .activity: "Activity"
		case .setup: "Setup"
		case .view(_, let view): view.name
		}
	}

	/// Overview, the loop's views, then the rest. Briefings appears only once the flow has
	/// published one; no views means no extra tab.
	static func tabs(views: [LoopView], hasBriefings: Bool) -> [LoopDetailTab] {
		var tabs: [LoopDetailTab] = [.overview]
		tabs += views.enumerated().map { .view(index: $0.offset, $0.element) }
		tabs += [.performance]
		if hasBriefings { tabs.append(.briefings) }
		tabs += [.items, .activity, .setup]
		return tabs
	}
}

/// The loop detail body without its scroll view (so it can be rendered offscreen in tests): the
/// title, status and tabs. Briefings appears only once the flow has published one.
struct LoopDetailContent: View {
	let store: LoopDetailStore
	var install: LoopInstall?
	/// The flow's timeline (comments and events). Nil in previews and tests: the Activity tab then
	/// shows the agents' posts and the run feed instead.
	var timeline: FlowTimelineModel?
	var onOpenTrigger: (String) -> Void = { _ in }
	/// Shown at the foot of Setup (pause, change in chat, delete).
	var setupFooter: AnyView?
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var tab: LoopDetailTab

	init(
		store: LoopDetailStore, install: LoopInstall? = nil, timeline: FlowTimelineModel? = nil,
		initialTab: LoopDetailTab = .overview, onOpenTrigger: @escaping (String) -> Void = { _ in },
		setupFooter: AnyView? = nil
	) {
		self.store = store
		self.install = install
		self.timeline = timeline
		self.onOpenTrigger = onOpenTrigger
		self.setupFooter = setupFooter
		_tab = State(initialValue: initialTab)
	}

	private var hasBriefings: Bool {
		runtime?.storiesStore()?.cards(forLoop: store.loop.id).isEmpty == false
	}

	private var tabs: [LoopDetailTab] {
		LoopDetailTab.tabs(views: store.views, hasBriefings: hasBriefings)
	}

	/// The open tab, or Overview when it no longer exists (a view was unpinned or the briefing went).
	private var openTab: LoopDetailTab { tabs.contains(tab) ? tab : .overview }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s10) {
			header
			if let problem = store.problem() {
				LoopProblemBanner(problem: problem, loop: store.loop, directory: store.directory)
			}
			FlowTabBar(tabs: tabs, selection: $tab)
			content
		}
	}

	@ViewBuilder
	private var content: some View {
		switch openTab {
		case .overview: overview
		case .view(_, let view): LoopCustomViewTab(view: view).id(view.fileID)
		case .performance: performance
		case .briefings: LoopBriefingsSection(loopID: store.loop.id)
		case .items: LoopInMotionSection(store: store)
		case .activity:
			if let timeline {
				FlowTimelineView(model: timeline)
			} else {
				LoopPostsSection(posts: store.posts, directory: store.directory, loopID: store.loop.id)
				activity
			}
		case .setup: setup
		}
	}

	// MARK: Tabs

	@ViewBuilder
	private var overview: some View {
		let cards = LoopOutcomes.cards(for: store.loop)
		let tags = store.loop.tags ?? []
		LoopPropertiesCard(store: store)
		LoopTargetsSection(cards: cards, directory: store.directory)
		LoopNeedsYouSection(store: store)
		OutcomesSection(outputs: store.outputs, sourceName: store.loop.displayName, producesStyle: true)
		if tags.isEmpty, cards.isEmpty, store.outputs.isEmpty, store.posts.filter(\.isDecision).isEmpty {
			emptyNote("Nothing to show yet. Targets and the pages this flow makes land here.")
		}
	}

	@ViewBuilder
	private var performance: some View {
		// Unknown is not empty: with the activity unread, the tiles and chart would show zeros.
		if store.failed(.activity) {
			blockError(.activity)
		} else {
			LoopStatsSection(loop: store.loop, failedSteps: store.failedSteps())
			LoopHealthSection(loop: store.loop, activity: store.activity, loaded: store.phase == .loaded)
			LoopRunChart(activity: store.activity, loaded: store.phase == .loaded)
		}
	}

	@ViewBuilder
	private var setup: some View {
		LoopAboutSection(loop: store.loop)
		if store.failed(.steps) {
			blockError(.steps)
		} else {
			LoopTriggersSection(steps: store.steps, onOpenTrigger: onOpenTrigger)
		}
		LoopStageSection(store: store)
		LoopAgentsSection(names: store.loop.agentIDs.compactMap { store.directory.name($0) })
		LoopScheduleSection(store: store)
		LoopConditionsSection(loop: store.loop)
		setupFooter
	}

	private func blockError(_ block: LoopDetailStore.Block) -> some View {
		LoopBlockError(message: block.message, isRetrying: store.isRetrying) {
			Task { await store.retry() }
		}
	}

	private func emptyNote(_ text: String) -> some View {
		Text(text)
			.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			.loopNote()
	}

	// MARK: Header

	private var header: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			Text(store.loop.displayName)
				.maskinText(.sheetTitle).foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)
			LoopStatusPill(loop: store.loop)
			if let driver = store.driver { LoopDriverPill(id: driver.id, name: driver.name) }
			if let notice = store.notice {
				FormError(notice).onTapGesture { store.notice = nil }
			}
			if store.failed(.description) { blockError(.description) }
			if let install, install.hasUpdate {
				Text(
					install.isForked
						? "v\(install.availableVersion) of the source is available. Your fork keeps its own version."
						: "Update to v\(install.availableVersion) available. Open the marketplace to review it."
				)
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.noticeFg2)
				.padding(MaskinSpace.s8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(
					MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			}
		}
	}

	/// Latest first, so the newest run is on screen without scrolling. Undated entries go last.
	private func newestFirst(_ entries: [LoopActivityEntry]) -> [LoopActivityEntry] {
		entries.enumerated().sorted {
			let a = $0.element.createdAt ?? .distantPast, b = $1.element.createdAt ?? .distantPast
			return a != b ? a > b : $0.offset < $1.offset
		}.map(\.element)
	}

	private var activity: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Recent activity")
			if store.failed(.activity) {
				blockError(.activity)
			} else if store.activity.isEmpty {
				Text(store.phase == .loaded ? "Nothing has run yet." : "")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(spacing: 0) {
					let recent = Array(newestFirst(store.activity).prefix(20))
					ForEach(Array(recent.enumerated()), id: \.element.id) { index, entry in
						LoopActivityRow(entry: entry, actorName: store.actorName(entry))
						if index < recent.count - 1 {
							Divider().overlay(MaskinSurface.separator)
						}
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
		}
	}
}

/// Overview, the loop's views, Performance, Briefings, Items, Activity, Setup: text tabs with an
/// ink underline under the open one, scrolling sideways when they don't fit.
struct FlowTabBar: View {
	let tabs: [LoopDetailTab]
	@Binding var selection: LoopDetailTab

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s10) {
				ForEach(tabs) { tab in
					let selected = tab == selection
					Button {
						MaskinHaptics.play(.selection)
						withAnimation(MaskinMotion.quick) { selection = tab }
					} label: {
						Text(tab.title)
							.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: selected ? .bold : .medium, relativeTo: .headline))
							.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
							.frame(minHeight: MaskinSpace.touchMin)
							.overlay(alignment: .bottom) {
								Rectangle().fill(selected ? MaskinColor.ink : Color.clear).frame(height: 2)
							}
					}
					.buttonStyle(.plain)
					.accessibilityAddTraits(selected ? .isSelected : [])
				}
			}
		}
		.overlay(alignment: .bottom) { Rectangle().fill(MaskinSurface.line).frame(height: 1) }
	}
}

/// "● Learning · Needs you": the flow's stage, with the warning colour when decisions wait.
struct LoopStatusPill: View {
	let loop: LoopSummary

	private var needsYou: Bool { loop.status.isLive && (loop.pill == .waitingOnYou || loop.waitingCount > 0) }

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			Circle().fill(loop.status.isLive ? MaskinColor.ok : MaskinColor.ink5)
				.frame(width: MaskinSpace.s4 + MaskinSpace.s1, height: MaskinSpace.s4 + MaskinSpace.s1)
			Text(loop.status.label).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
			if needsYou {
				Text("· Needs you").fontWeight(.semibold).foregroundStyle(MaskinColor.warning)
			}
		}
		.maskinText(.subhead)
		.padding(.horizontal, MaskinSpace.s8)
		.frame(minHeight: MaskinSpace.touchMin)
		.background(MaskinSurface.card, in: Capsule())
		.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .combine)
		.accessibilityLabel("Status: \(loop.status.label)" + (needsYou ? ", needs you" : ""))
	}
}

/// UNDER THE HOOD: Learning, Supervised, Autonomous as chips with a one-line explanation. Changing
/// it moves the Status pill. Hidden while the flow is a draft or paused, since it has no stage then.
struct LoopStageSection: View {
	let store: LoopDetailStore

	var body: some View {
		if let current = LoopStage(status: store.loop.status) {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Under the hood")
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: MaskinSpace.s4) {
						ForEach(LoopStage.allCases, id: \.self) { stage in
							AgentFilterChip(label: stage.title, selected: stage == current) {
								Task { await store.setStage(stage) }
							}
							.disabled(store.isTogglingPause)
						}
					}
				}
				Text(current.note).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.padding(.horizontal, MaskinSpace.s3)
			}
		}
	}
}

/// AGENTS: who works the flow, by name. Nothing when none resolve.
struct LoopAgentsSection: View {
	let names: [String]

	var body: some View {
		if !names.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Agents")
				VStack(spacing: 0) {
					ForEach(Array(names.enumerated()), id: \.offset) { index, name in
						HStack(spacing: MaskinSpace.s6) {
							ActorAvatar(name: name, kind: .agent, size: MaskinSpace.s13, seed: name)
							Text(name).maskinText(.body).foregroundStyle(MaskinColor.ink)
							Spacer(minLength: 0)
						}
						.padding(.vertical, MaskinSpace.s5)
						.accessibilityElement(children: .combine)
						if index < names.count - 1 { Divider().overlay(MaskinSurface.separator) }
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
		}
	}
}

/// One line of the activity feed.
struct LoopActivityRow: View {
	let entry: LoopActivityEntry
	let actorName: String?

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
			Circle().fill(color).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(entry.title).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
				if let actorName {
					Text(actorName).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
			Spacer(minLength: MaskinSpace.s3)
			RelativeTime(entry.createdAt, style: .compact)
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
		.padding(.vertical, MaskinSpace.s5)
		.accessibilityElement(children: .combine)
	}

	private var color: Color {
		switch entry.tone {
		case .success: MaskinColor.ink
		case .failure: MaskinColor.warning
		case .active: MaskinColor.sig
		case .neutral: MaskinColor.ink5
		}
	}
}

/// "D Developer drives": opens a chat with the flow's driver (the existing one, or a new one).
struct LoopDriverPill: View {
	let id: String
	let name: String
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var opening = false

	var body: some View {
		Button(action: open) {
			HStack(spacing: MaskinSpace.s5) {
				ActorAvatar(name: name, kind: .agent, size: MaskinSpace.s13, seed: id)
				(Text(name).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
					+ Text(" drives").foregroundStyle(MaskinColor.ink4))
					.maskinText(.subhead)
			}
			.padding(.leading, MaskinSpace.s4)
			.padding(.trailing, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(MaskinSurface.card, in: Capsule())
			.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(opening)
		.accessibilityLabel("\(name) drives this flow")
		.accessibilityHint("Opens a chat with \(name)")
	}

	private func open() {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return }
		opening = true
		Task {
			defer { opening = false }
			let source = APIChatsSource(client: runtime.environment.client, workspaceID: workspaceID)
			if let chat = try? await source.directChat(
				with: id, title: name, idempotencyKey: UUID().uuidString)
			{
				runtime.openChat(chat.id)
			}
		}
	}
}
