import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One agent: a hero with its editable identity, what it is doing now, and a vertical page menu (Setup,
/// Triggers, Objects, Sessions, plus Computer while it has one). Name, what it owns, instructions
/// and tools are editable here; everything saves optimistically and rolls back with a notice if
/// the server refuses.
struct AgentDetailView: View {
	let store: AgentDetailStore
	/// Called once the agent is deleted so the host can leave the screen.
	var onDeleted: () -> Void = {}
	/// The flows this agent works in, by name. Empty while loading or when it is in none.
	var flows: [LoopSummary] = []
	/// The workspace's triggers; the ones that wake this agent show on its Triggers tab. Nil in previews.
	var triggers: TriggersStore?
	/// The objects this agent drives (its Overview). Empty while loading.
	var objects: [WorkObject] = []
	@State private var showNewTrigger = false
	@State private var showComputer = false
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var confirmReset = false
	@State private var confirmDelete = false
	@State private var sessionToStop: AgentSession?
	@State private var logSession: AgentSession?

	/// Agents are changed by talking to someone, not through a form.
	private func changeInChat() {
		guard let name = store.profile?.name else { return }
		runtime?.buildInChat("I'd like to change the agent \(name). ")
	}

	/// Start a conversation with this agent, or straight into a live call with it.
	private func startChat(live: Bool) {
		guard let profile = store.profile else { return }
		runtime?.startChat(
			with: ChatParticipant(id: profile.id, name: profile.name, kind: .agent), live: live)
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				if let profile = store.profile {
					AgentDetailContent(
						profile: profile, store: store, flows: flows,
						triggers: triggers?.triggers.filter { $0.targetActorID == profile.id } ?? [],
						onToggleTrigger: { id, on in Task { await triggers?.setEnabled(id, on) } },
						onNewTrigger: triggers == nil ? nil : { showNewTrigger = true },
						onStop: { sessionToStop = $0 },
						onRetry: { session in Task { await store.retry(session) } },
						onOpenLog: runtime == nil ? nil : { logSession = $0 },
						onChangeInChat: { changeInChat() },
						objects: objects, onOpenObject: { runtime?.openObject($0) },
						onOpenFlow: runtime == nil ? nil : { runtime?.openLoop($0) },
						onOpenComputer: computerAction)
				} else {
					placeholder
				}
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
		.toolbar {
			if store.profile != nil {
				ToolbarItemGroup(placement: .primaryAction) {
					Button { startChat(live: false) } label: { Image(systemName: "message") }
						.accessibilityLabel("Message \(store.profile?.name ?? "agent")")
					Button { startChat(live: true) } label: { Image(systemName: "waveform") }
						.accessibilityLabel("Live with \(store.profile?.name ?? "agent")")
					Menu {
						if store.canEnable {
							Button("Enable agent") { Task { await store.enable() } }
						} else if store.canDisable {
							Button("Disable agent") { Task { await store.disable() } }
						}
						if store.canReset { Button("Reset to defaults") { confirmReset = true } }
						if store.canDelete {
							Button("Delete agent", role: .destructive) { confirmDelete = true }
						}
					} label: { Image(systemName: "ellipsis") }
						.accessibilityLabel("More for \(store.profile?.name ?? "agent")")
				}
			}
		}
		.refreshable { await store.refresh() }
		.sheet(item: $logSession) { session in
			if let runtime, let workspaceID = runtime.environment.workspaceId {
				NavigationStack {
					SessionLogsView(
						sessionID: session.id,
						api: APISessionLogsSource(client: runtime.environment.client, workspaceID: workspaceID),
						session: store.sessions.first { $0.id == session.id } ?? session)
				}
				.presentationDetents([.large])
			}
		}
		.sheet(isPresented: $showNewTrigger) {
			if let triggers {
				NewTriggerSheet(store: triggers, onCreated: { _ in }, presetAgentID: store.profile?.id)
			}
		}
		#if os(iOS)
		.fullScreenCover(isPresented: $showComputer) {
			if let runtime, let profile = store.profile {
				ComputerScreen(
					agentName: profile.name, agentID: profile.id, environment: runtime.environment,
					onDone: { showComputer = false })
			}
		}
		#endif
		.confirmationDialog(
			"Reset \(store.profile?.name ?? "agent") to factory defaults?", isPresented: $confirmReset,
			titleVisibility: .visible
		) {
			Button("Reset", role: .destructive) { Task { await store.reset() } }
		} message: {
			Text("Instructions, tools and skills go back to their built-in defaults. This can't be undone.")
		}
		.confirmationDialog(
			"Delete \(store.profile?.name ?? "this agent")?", isPresented: $confirmDelete,
			titleVisibility: .visible
		) {
			Button("Delete agent", role: .destructive) {
				Task { if await store.delete() { onDeleted() } }
			}
		} message: {
			Text("Its past sessions stay in history, but it can't run again. This can't be undone.")
		}
		.confirmationDialog(
			"Stop this session?", isPresented: Binding(get: { sessionToStop != nil }, set: { if !$0 { sessionToStop = nil } }),
			titleVisibility: .visible, presenting: sessionToStop
		) { session in
			Button("Stop session", role: .destructive) { Task { await store.stopSession(session.id) } }
		} message: { _ in
			Text("The agent stops what it's doing now. Work in progress may be lost.")
		}
		.alert(
			"Something went wrong", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(store.notice ?? "")
		}
	}

	/// The Computer tab opens the live view. Only on iOS, where the viewer exists.
	private var computerAction: (() -> Void)? {
		#if os(iOS)
		runtime == nil ? nil : { showComputer = true }
		#else
		nil
		#endif
	}

	@ViewBuilder
	private var placeholder: some View {
		switch store.phase {
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't open this agent", message: message) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		default:
			LoadingSkeleton(rows: 5)
		}
	}
}

/// The loaded body, split out so snapshots can render it without sheets and dialogs.
struct AgentDetailContent: View {
	let profile: AgentProfile
	let store: AgentDetailStore
	var flows: [LoopSummary] = []
	/// The triggers that wake this agent, already filtered.
	var triggers: [Trigger] = []
	var onToggleTrigger: (String, Bool) -> Void = { _, _ in }
	/// Nil hides "New trigger" (previews, or no trigger store).
	var onNewTrigger: (() -> Void)?
	var onStop: (AgentSession) -> Void = { _ in }
	var onRetry: (AgentSession) -> Void = { _ in }
	/// Nil hides the log links (previews, snapshots).
	var onOpenLog: ((AgentSession) -> Void)?
	var onChangeInChat: () -> Void = {}
	/// The objects this agent drives, and what tapping one does.
	var objects: [WorkObject] = []
	var onOpenObject: (String) -> Void = { _ in }
	/// Nil hides the flow chips' action (they still show).
	var onOpenFlow: ((String) -> Void)?
	/// Nil hides the Computer tab.
	var onOpenComputer: (() -> Void)?

	enum Tab: String, CaseIterable, Identifiable {
		case overview = "Overview"
		case setup = "Setup"
		case triggers = "Triggers"
		case objects = "Objects"
		case sessions = "Sessions"
		case computer = "Computer"
		var id: String { rawValue }
	}

	private enum Field: Hashable { case name, owns, instructions }

	@State private var tab: Tab = .overview
	@State private var sessionFilter: AgentSessionFilter = .all
	@State private var nameDraft = ""
	@State private var ownsDraft = ""
	@State private var instructionsDraft = ""
	@FocusState private var focus: Field?

	/// The pages the menu offers; Computer only while the agent has a live one.
	private var pages: [Tab] {
		Tab.allCases.filter {
			$0 != .overview && ($0 != .computer || (onOpenComputer != nil && store.liveSession != nil))
		}
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s12) {
			if tab == .overview {
				hero
				banner
				statsRow
				pageMenu
			} else {
				pageHeader
				banner
				switch tab {
				case .setup: setup
				case .triggers: triggersTab
				case .objects: objectsPage
				case .sessions: sessions
				case .computer: computer
				case .overview: EmptyView()
				}
			}
		}
		.onChange(of: profile.name, initial: true) { _, name in if focus != .name { nameDraft = name } }
		.onChange(of: profile.description, initial: true) { _, text in
			if focus != .owns { ownsDraft = text ?? "" }
		}
		.onChange(of: profile.systemPrompt, initial: true) { _, text in
			if focus != .instructions { instructionsDraft = text ?? "" }
		}
		.onChange(of: focus) { old, _ in
			switch old {
			case .name: commitName()
			case .owns: commitOwns()
			case .instructions: commitInstructions()
			case nil: break
			}
		}
	}

	// MARK: - Hero

	private var hero: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s8) {
			HStack(spacing: MaskinSpace.s9) {
				ActorAvatar(
					name: profile.name, kind: .agent, size: MaskinSpace.s14 * 2, seed: profile.id,
					mood: AgentMood(store.status))
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					TextField("Name", text: $nameDraft)
						.maskinText(.title)
						.foregroundStyle(MaskinColor.ink)
						.focused($focus, equals: .name)
						.submitLabel(.done)
						.onSubmit { focus = nil }
					AgentStatusLabel(status: store.status)
				}
			}
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
				Text("Owns").maskinText(.body).foregroundStyle(MaskinColor.ink4)
				TextField("What does this agent own?", text: $ownsDraft, axis: .vertical)
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink)
					.focused($focus, equals: .owns)
					.padding(.bottom, MaskinSpace.s1)
					.overlay(alignment: .bottom) {
						Rectangle().stroke(MaskinSurface.line, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
							.frame(height: 1)
					}
			}
			if !flows.isEmpty {
				HStack(alignment: .center, spacing: MaskinSpace.s3) {
					Text("Works in").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					ScrollView(.horizontal, showsIndicators: false) {
						HStack(spacing: MaskinSpace.s3) {
							ForEach(flows) { flow in flowChip(flow) }
						}
					}
				}
			}
		}
	}

	@ViewBuilder
	private func flowChip(_ flow: LoopSummary) -> some View {
		let label = Text(AgentTeams.name(of: flow))
			.maskinText(.subhead).fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.touchMin)
			.overlay(Capsule().strokeBorder(MaskinSurface.line))
			.contentShape(Capsule())
		if let onOpenFlow {
			Button { onOpenFlow(flow.id) } label: { label }.buttonStyle(.maskinPressed(.shrink))
		} else {
			label
		}
	}

	private func commitName() {
		let name = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !name.isEmpty else { nameDraft = profile.name; return }
		guard name != profile.name else { return }
		Task { await store.save(AgentEdit(name: name)) }
	}

	private func commitOwns() {
		let text = ownsDraft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard text != (profile.description ?? "") else { return }
		Task { await store.save(AgentEdit(description: text)) }
	}

	private func commitInstructions() {
		guard instructionsDraft != (profile.systemPrompt ?? "") else { return }
		Task { await store.save(AgentEdit(systemPrompt: instructionsDraft)) }
	}

	// MARK: - Banner: failed, working now, or disabled

	@ViewBuilder private var banner: some View {
		if let live = store.liveSession, live.isActive {
			workingNow(live)
		} else if store.status == .paused {
			Text("Disabled. Running sessions were held where they stopped. Enable the agent to continue.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(MaskinSpace.s9)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		} else if store.status == .failed, let failed = store.sessions.first(where: \.isFailure) {
			failedBanner(failed)
		}
	}

	private func workingNow(_ live: AgentSession) -> some View {
		let title = live.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
		return HStack(spacing: MaskinSpace.s7) {
			Circle().fill(MaskinColor.sigInk).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				MonoLabel("Working now")
				Text(title.isEmpty ? (live.currentActivity ?? "A run") : title)
					.maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(3)
				if let seconds = live.duration() {
					Text("Running for \(AgentDuration.words(seconds))")
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
			}
			Spacer(minLength: MaskinSpace.s3)
			if let onOpenLog { textButton("Watch", tint: MaskinColor.sigInk) { onOpenLog(live) } }
			textButton("Stop", tint: MaskinColor.ink3) { onStop(live) }
		}
		.padding(MaskinSpace.s9)
		.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.accessibilityElement(children: .contain)
	}

	private func failedBanner(_ session: AgentSession) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s5) {
				Circle().fill(MaskinStatus.alert.fg).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					.accessibilityHidden(true)
				Text("\(profile.name) stopped on its last run")
					.maskinText(.headline).foregroundStyle(MaskinColor.ink)
			}
			Text("The run ended before it finished.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			HStack(spacing: MaskinSpace.s7) {
				if store.canRun { textButton("Retry", tint: MaskinColor.sigInk) { onRetry(session) } }
				if let onOpenLog { textButton("See log", tint: MaskinColor.ink) { onOpenLog(session) } }
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.accessibilityElement(children: .contain)
	}

	private func textButton(_ title: String, tint: Color, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title).maskinText(.body).fontWeight(.semibold).foregroundStyle(tint)
				.frame(minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}

	// MARK: - Stats and tabs

	@ViewBuilder private var statsRow: some View {
		let stats = store.stats
		HStack(alignment: .top, spacing: MaskinSpace.s9) {
			if stats.total > 0 { stat("\(stats.total)", stats.total == 1 ? "Session" : "Sessions") }
			if let well = stats.finishedWell { stat(well, "Finished well") }
			if !flows.isEmpty { stat("\(flows.count)", flows.count == 1 ? "Flow" : "Flows") }
			if !objects.isEmpty { stat("\(objects.count)", objects.count == 1 ? "Item" : "Items") }
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func stat(_ value: String, _ label: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(value).maskinText(.title).foregroundStyle(MaskinColor.ink)
			Text(label).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		}
		.accessibilityElement(children: .combine)
	}

	private func summary(_ page: Tab) -> String {
		switch page {
		case .setup: "Instructions, tools, skills"
		case .triggers: triggers.isEmpty ? "None" : "\(triggers.count)"
		case .objects: objects.isEmpty ? "None" : "\(objects.count)"
		case .sessions: store.sessions.isEmpty ? "No runs yet" : "\(store.sessions.count) recent"
		case .computer: "Live view"
		case .overview: ""
		}
	}

	private func icon(_ page: Tab) -> String {
		switch page {
		case .setup: "slider.horizontal.3"
		case .triggers: "bolt"
		case .objects: "square.stack.3d.up"
		case .sessions: "clock"
		case .computer: "display"
		case .overview: "circle"
		}
	}

	/// The vertical page menu under the hero: one row per page, each with its own summary.
	private var pageMenu: some View {
		VStack(spacing: 0) {
			ForEach(pages) { page in
				Button {
					MaskinHaptics.play(.selection)
					tab = page
				} label: {
					HStack(spacing: MaskinSpace.s7) {
						Image(systemName: icon(page)).font(.body).foregroundStyle(MaskinColor.ink3)
							.frame(width: MaskinSpace.s12).accessibilityHidden(true)
						Text(page.rawValue).maskinText(.body).foregroundStyle(MaskinColor.ink)
						Spacer(minLength: MaskinSpace.s3)
						Text(summary(page)).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
						Image(systemName: "chevron.right")
							.font(.footnote.weight(.semibold)).foregroundStyle(MaskinColor.ink5)
							.accessibilityHidden(true)
					}
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				Divider().overlay(MaskinSurface.separator)
			}
		}
	}

	/// A sub-page's header: back to the overview, then the page's name.
	private var pageHeader: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Button {
				MaskinHaptics.play(.selection)
				focus = nil
				tab = .overview
			} label: {
				Label(profile.name, systemImage: "chevron.left")
					.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.sigInk)
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			Text(tab.rawValue).maskinText(.title).foregroundStyle(MaskinColor.ink)
		}
	}

	// MARK: - Objects

	@ViewBuilder private var objectsPage: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			if objects.isEmpty {
				Text("Nothing yet. Message \(profile.name) to give it work.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			}
			ForEach(objects) { object in
				Button { onOpenObject(object.id) } label: {
					HStack(spacing: MaskinSpace.s5) {
						Text(object.title ?? "Untitled")
							.maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(2)
							.multilineTextAlignment(.leading)
						Spacer(minLength: MaskinSpace.s3)
						Text(MaskinStatus.label(for: object.status).capitalized)
							.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
						Image(systemName: "chevron.right")
							.font(.footnote.weight(.semibold)).foregroundStyle(MaskinColor.ink5)
							.accessibilityHidden(true)
					}
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				Divider().overlay(MaskinSurface.separator)
			}
		}
	}

	// MARK: - Sessions

	@ViewBuilder private var sessions: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s4) {
					ForEach(AgentSessionFilter.allCases) { option in
						AgentFilterChip(label: option.title, selected: option == sessionFilter) {
							sessionFilter = option
						}
					}
				}
			}
			let shown = store.sessions.filter(sessionFilter.matches)
			if shown.isEmpty {
				Text(store.sessions.isEmpty ? "No runs yet." : "No sessions match.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.padding(.top, MaskinSpace.s4)
			}
			ForEach(shown) { session in
				sessionRow(session, actions: true)
				Divider().overlay(MaskinSurface.separator)
			}
		}
	}

	private func sessionRow(_ session: AgentSession, actions: Bool) -> some View {
		let colors = MaskinStatus.colors(for: session.status)
		let title = session.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
		return HStack(spacing: MaskinSpace.s5) {
			Button { onOpenLog?(session) } label: {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
					Circle().fill(colors.fg).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
						.accessibilityHidden(true)
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(title.isEmpty ? "Run" : title)
							.maskinText(.body).foregroundStyle(MaskinColor.ink)
							.lineLimit(3).multilineTextAlignment(.leading)
						sessionMeta(session)
					}
					Spacer(minLength: 0)
				}
				.frame(minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.disabled(onOpenLog == nil)
			.accessibilityHint(onOpenLog == nil ? "" : "Opens the session log")
			if actions {
				if session.isStoppable {
					textButton("Stop", tint: MaskinColor.ink3) { onStop(session) }
				} else if session.canRetry, store.canRun {
					textButton("Retry", tint: MaskinColor.sigInk) { onRetry(session) }
				}
			}
			Text(session.stateLabel)
				.maskinText(.caption).fontWeight(.semibold)
				.foregroundStyle(colors.fg)
				.padding(.horizontal, MaskinSpace.s5).padding(.vertical, MaskinSpace.s2)
				.background(colors.bg, in: Capsule())
				.fixedSize()
		}
	}

	@ViewBuilder
	private func sessionMeta(_ session: AgentSession) -> some View {
		HStack(spacing: MaskinSpace.s2) {
			if session.isActive, let seconds = session.duration() {
				Text("Running for \(AgentDuration.words(seconds))")
			} else {
				if let seconds = session.duration() { Text(AgentDuration.words(seconds)) }
				if session.activityDate != nil {
					if session.duration() != nil { Text("·") }
					RelativeTime(session.activityDate, style: .relative)
				}
			}
		}
		.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
	}

	// MARK: - Setup

	@ViewBuilder private var setup: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s12) {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				SectionHeader("Instructions") {
					Button("Change in chat", action: onChangeInChat)
						.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.sigInk)
				}
				TextField("What is this agent's job?", text: $instructionsDraft, axis: .vertical)
					.maskinText(.body).foregroundStyle(MaskinColor.ink2)
					.lineLimit(4...12)
					.focused($focus, equals: .instructions)
					.padding(MaskinSpace.s9)
					.overlay(
						RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
							.strokeBorder(MaskinSurface.line))
			}
			if !profile.tools.isEmpty {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					SectionHeader("Tools")
					ForEach(profile.tools) { tool in
						HStack {
							Text(tool.name).maskinText(.body).foregroundStyle(MaskinColor.ink)
							Spacer(minLength: MaskinSpace.s3)
							MonoLabel("MCP")
						}
						.frame(minHeight: MaskinSpace.touchMin)
						.accessibilityElement(children: .combine)
						Divider().overlay(MaskinSurface.separator)
					}
				}
			}
			if !profile.skills.isEmpty {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					SectionHeader("Skills")
					ForEach(profile.skills, id: \.self) { skill in
						Text(skill).maskinText(.body).foregroundStyle(MaskinColor.ink)
							.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
							.frame(maxWidth: .infinity, alignment: .leading)
						Divider().overlay(MaskinSurface.separator)
					}
				}
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				SectionHeader("Model")
				HStack {
					Text("Model").maskinText(.body).foregroundStyle(MaskinColor.ink)
					Spacer(minLength: MaskinSpace.s3)
					Text(profile.llmProvider ?? "Workspace default")
						.maskinText(.body).foregroundStyle(MaskinColor.ink4)
				}
				.frame(minHeight: MaskinSpace.touchMin)
				.accessibilityElement(children: .combine)
			}
		}
	}

	private func outlinedButton(_ title: String, tint: Color, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(tint)
				.padding(.horizontal, MaskinSpace.s9)
				.frame(minHeight: MaskinSpace.touchMin)
				.overlay(Capsule().strokeBorder(MaskinSurface.line))
				.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed(.shrink))
	}

	// MARK: - Triggers

	@ViewBuilder private var triggersTab: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			if triggers.isEmpty {
				Text("Nothing wakes this agent yet. Add a schedule or an event.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			}
			ForEach(triggers) { trigger in
				HStack(spacing: MaskinSpace.s7) {
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(trigger.name).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(2)
						Text(trigger.summary).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(3)
					}
					Spacer(minLength: MaskinSpace.s3)
					Toggle(
						"Enabled",
						isOn: Binding(get: { trigger.enabled }, set: { onToggleTrigger(trigger.id, $0) })
					)
					.labelsHidden()
					.accessibilityLabel("\(trigger.name) enabled")
				}
				.frame(minHeight: MaskinSpace.touchMin)
				Divider().overlay(MaskinSurface.separator)
			}
			if let onNewTrigger {
				outlinedButton("+ New trigger", tint: MaskinColor.ink, action: onNewTrigger)
			}
		}
	}

	// MARK: - Computer

	@ViewBuilder private var computer: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			if let live = store.liveSession {
				let title = live.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					Text("\(profile.name)'s computer").maskinText(.headline).foregroundStyle(MaskinColor.ink)
					Text(title.isEmpty ? "Live" : "Live · \(title)")
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					if let onOpenComputer {
						Button(action: onOpenComputer) { Label("Open computer", systemImage: "display") }
							.buttonStyle(.primaryAction)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(MaskinSpace.s9)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
			Text("When the agent gets stuck, for example on a sign-in or a captcha, it asks you in chat. You can watch its screen here and take over.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
		}
	}
}

enum SessionDuration {
	static func format(_ seconds: TimeInterval) -> String {
		let total = Int(seconds)
		if total < 60 { return "\(total)s" }
		if total < 3600 { return "\(total / 60)m" }
		return "\(total / 3600)h \((total % 3600) / 60)m"
	}
}

extension View {
	/// The large rounded card surface used across the Agents screens.
	func agentSurface() -> some View {
		background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
					.strokeBorder(MaskinSurface.line)
			)
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
	}
}
