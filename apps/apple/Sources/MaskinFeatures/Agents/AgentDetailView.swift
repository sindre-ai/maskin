import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One agent: a hero with its identity and a one-tap run, then instructions, tools, setup and
/// recent sessions. Name, role, instructions and tools are editable here; everything saves
/// optimistically and rolls back with a notice if the server refuses.
struct AgentDetailView: View {
	let store: AgentDetailStore
	/// Called once the agent is deleted so the host can leave the screen.
	var onDeleted: () -> Void = {}
	/// The flows this agent works in, by name. Empty while loading or when it is in none.
	var flows: [LoopSummary] = []
	/// The workspace's triggers; the ones that wake this agent show as a card. Nil in previews.
	var triggers: TriggersStore?
	/// The objects this agent drives (its Objects tab). Empty while loading.
	var objects: [WorkObject] = []
	@State private var showRun = false
	@State private var showNewTrigger = false
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var confirmReset = false
	@State private var confirmDelete = false
	@State private var sessionToStop: AgentSession?
	@State private var logSession: AgentSession?
	@State private var showInstructions = false
	#if os(iOS)
	@State private var showComputer = false
	#endif

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
						onRun: { runTapped() },
						onPause: { Task { await store.pause() } },
						onReset: { confirmReset = true },
						onStop: { sessionToStop = $0 },
						onOpenLog: runtime == nil ? nil : { logSession = $0 },
						onChangeInChat: { changeInChat() },
						onEditInstructions: { showInstructions = true },
						onOpenComputer: computerAction,
						objects: objects, onOpenObject: { runtime?.openObject($0) })
				} else {
					placeholder
				}
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 720, alignment: .leading)
			.frame(maxWidth: .infinity)
		}
		.ambientBackground()
		.navigationTitle(store.profile?.name ?? "")
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.toolbar {
			if store.profile != nil {
				ToolbarItemGroup(placement: .primaryAction) {
					Button { startChat(live: true) } label: { Image(systemName: "waveform") }
						.accessibilityLabel("Live with \(store.profile?.name ?? "agent")")
					Button { startChat(live: false) } label: { Image(systemName: "plus") }
						.accessibilityLabel("New chat with \(store.profile?.name ?? "agent")")
					Menu {
						if AgentActions.canPause(store.status) {
							Button { Task { await store.pause() } } label: {
								Label("Disable agent", systemImage: "pause.circle")
							}
							.disabled(!store.canPause)
						} else if store.status == .paused {
							Button { runTapped() } label: { Label("Enable agent", systemImage: "play.circle") }
								.disabled(!store.canRun)
						}
						if store.canReset {
							Button { confirmReset = true } label: { Label("Reset to defaults", systemImage: "arrow.counterclockwise") }
						}
						if store.canDelete {
							Divider()
							Button(role: .destructive) { confirmDelete = true } label: {
								Label("Delete agent", systemImage: "trash")
							}
						}
					} label: {
						Image(systemName: "ellipsis")
					}
					.accessibilityLabel("Agent actions")
				}
			}
		}
		.refreshable { await store.refresh() }
		.sheet(isPresented: $showRun) {
			RunAgentSheet(agentName: store.profile?.name ?? "this agent") { prompt in
				await store.run(prompt: prompt)
			}
			.presentationDetents([.medium, .large])
			.presentationCornerRadius(MaskinRadius.hero + MaskinSpace.s4)
		}
		.sheet(item: $logSession) { session in
			if let runtime, let workspaceID = runtime.environment.workspaceId {
				NavigationStack {
					SessionLogsView(
						sessionID: session.id,
						api: APISessionLogsSource(client: runtime.environment.client, workspaceID: workspaceID),
						session: store.sessions.first { $0.id == session.id } ?? session,
						onStop: { _ = await store.stopSession(session.id) })
				}
				.presentationDetents([.large])
			}
		}
		.sheet(isPresented: $showInstructions) {
			InstructionsEditorSheet(
				agentName: store.profile?.name ?? "this agent", initial: store.profile?.systemPrompt ?? ""
			) { text in await store.save(AgentEdit(systemPrompt: text)) }
			.presentationDetents([.large])
		}
		#if os(iOS)
		.fullScreenCover(isPresented: $showComputer) {
			if let runtime, let profile = store.profile {
				ComputerScreen(
					agentName: profile.name, agentID: profile.id, environment: runtime.environment,
					onDone: {})
			}
		}
		#endif
		.sheet(isPresented: $showNewTrigger) {
			if let triggers {
				NewTriggerSheet(store: triggers, onCreated: { _ in }, presetAgentID: store.profile?.id)
			}
		}
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

	/// The page menu's Computer row: iPhone and iPad only, where the live view exists.
	private var computerAction: (() -> Void)? {
		#if os(iOS)
		runtime == nil ? nil : { showComputer = true }
		#else
		nil
		#endif
	}

	/// Resuming a paused agent needs no prompt; a fresh run asks what to do.
	private func runTapped() {
		if store.status == .paused {
			Task { await store.run(prompt: nil) }
		} else {
			showRun = true
		}
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
	/// Nil hides the card's "New trigger" action (previews, or no trigger store).
	var onNewTrigger: (() -> Void)?
	var onRun: () -> Void = {}
	var onPause: () -> Void = {}
	var onReset: () -> Void = {}
	var onStop: (AgentSession) -> Void = { _ in }
	/// Nil hides the log link on a session row (previews, snapshots).
	var onOpenLog: ((AgentSession) -> Void)?
	var onChangeInChat: () -> Void = {}
	/// Nil hides the instructions Edit action (previews, snapshots).
	var onEditInstructions: (() -> Void)?
	/// Nil hides the Computer row (no runtime, or a platform without the live view).
	var onOpenComputer: (() -> Void)?
	/// The objects this agent drives, and what tapping one does.
	var objects: [WorkObject] = []
	var onOpenObject: (String) -> Void = { _ in }

	/// The agent page's sub pages, listed under the hero: how it is set up, what wakes it, what it
	/// drives, and what it has done.
	enum Page: String, CaseIterable, Identifiable {
		case setup = "Setup"
		case triggers = "Triggers"
		case objects = "Objects"
		case sessions = "Sessions"
		case computer = "Computer"
		var id: String { rawValue }

		var symbol: String {
			switch self {
			case .setup: "slider.horizontal.3"
			case .triggers: "bolt"
			case .objects: "square.stack"
			case .sessions: "clock.arrow.circlepath"
			case .computer: "desktopcomputer"
			}
		}
	}

	var body: some View {
		hero
		if store.status == .paused {
			note("Disabled. Running sessions were held where they stopped. Enable the agent to continue.")
		}
		if store.status == .failed, let failed = store.sessions.first(where: \.isFailure) {
			failedCard(failed)
		}
		if let live = store.liveSession {
			card("Working now") { LiveSessionRow(session: live) { onStop(live) } }
		}
		stats
		VStack(spacing: 0) {
			ForEach(pages) { page in
				if page == .computer {
					Button { onOpenComputer?() } label: { pageRow(page) }
						.buttonStyle(.plain)
				} else {
					NavigationLink {
						subpage(page)
					} label: {
						pageRow(page)
					}
					.buttonStyle(.plain)
				}
				if page != pages.last { Divider().overlay(MaskinSurface.separator) }
			}
		}
		.padding(.horizontal, MaskinSpace.s10)
		.frame(maxWidth: .infinity, alignment: .leading)
		.agentSurface()
	}

	/// The page menu; Computer only where the live view can open.
	private var pages: [Page] {
		Page.allCases.filter { $0 != .computer || onOpenComputer != nil }
	}

	/// A short grey notice under the hero (the disabled state).
	private func note(_ text: String) -> some View {
		Text(text)
			.maskinText(.subhead)
			.foregroundStyle(MaskinColor.ink4)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(MaskinSpace.s8)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}

	/// The last run failed: say so, with Retry and See log.
	private func failedCard(_ session: AgentSession) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			HStack(spacing: MaskinSpace.s4) {
				Circle().fill(MaskinStatus.colors(for: AgentStatus.failed.badgeKey).fg)
					.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				Text("\(profile.name) stopped on its last run").maskinText(.headline).foregroundStyle(MaskinColor.ink)
			}
			if !session.prompt.isEmpty {
				Text(session.prompt).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(2)
			}
			HStack(spacing: MaskinSpace.s9) {
				Button("Retry", action: onRun)
				if let onOpenLog { Button("See log") { onOpenLog(session) } }
			}
			.maskinText(.subhead).fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink)
			.padding(.top, MaskinSpace.s2)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(MaskinSpace.s8)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}

	/// Sessions, how many finished well, flows and items, as four big numbers.
	private var stats: some View {
		let finished = store.sessions.filter { !$0.isActive && !$0.isPaused }
		let done = finished.filter { $0.status == "completed" }.count
		return HStack(alignment: .top) {
			stat("\(store.sessions.count)", "Sessions")
			Spacer(minLength: MaskinSpace.s3)
			stat(finished.isEmpty ? "-" : "\(done)/\(finished.count)", "Finished well")
			Spacer(minLength: MaskinSpace.s3)
			stat("\(flows.count)", flows.count == 1 ? "Flow" : "Flows")
			Spacer(minLength: MaskinSpace.s3)
			stat("\(objects.count)", "Items")
		}
		.padding(.horizontal, MaskinSpace.s2)
		.accessibilityElement(children: .combine)
	}

	private func stat(_ value: String, _ label: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(value).maskinText(.title).foregroundStyle(MaskinColor.ink)
			Text(label).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
		}
	}

	private func summary(_ page: Page) -> String {
		switch page {
		case .setup: "Instructions, tools, skills"
		case .triggers: triggers.isEmpty ? "None" : "\(triggers.count)"
		case .objects: objects.isEmpty ? "None" : "\(objects.count)"
		case .sessions: store.sessions.isEmpty ? "No runs yet" : "\(store.sessions.count) recent"
		case .computer: "Live view"
		}
	}

	private func pageRow(_ page: Page) -> some View {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: page.symbol)
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: MaskinSpace.s10)
				.accessibilityHidden(true)
			Text(page.rawValue).maskinText(.body).foregroundStyle(MaskinColor.ink)
			Spacer(minLength: MaskinSpace.s3)
			Text(summary(page)).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(1)
			Image(systemName: "chevron.right")
				.foregroundStyle(MaskinColor.ink5)
				.accessibilityHidden(true)
		}
		.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s3)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
	}

	private func subpage(_ page: Page) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				switch page {
				case .setup: setupCards
				case .triggers: triggerCards
				case .objects: objectCards
				case .sessions: sessionCards
				case .computer: EmptyView()
				}
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 720, alignment: .leading)
			.frame(maxWidth: .infinity)
		}
		.ambientBackground()
		.navigationTitle(page.rawValue)
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
	}

	@ViewBuilder private var triggerCards: some View {
		card("Triggers", action: onNewTrigger.map { ("New trigger", "plus", $0) }) {
			if triggers.isEmpty {
				Text("Nothing wakes this agent yet. Add a schedule or an event.")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					ForEach(triggers) { trigger in
						HStack(spacing: MaskinSpace.s5) {
							Image(systemName: trigger.kind.symbol)
								.foregroundStyle(trigger.enabled ? MaskinColor.ink3 : MaskinColor.ink5)
								.accessibilityHidden(true)
							VStack(alignment: .leading, spacing: MaskinSpace.s1) {
								Text(trigger.name)
									.maskinText(.subhead)
									.foregroundStyle(trigger.enabled ? MaskinColor.ink2 : MaskinColor.ink4)
									.lineLimit(1)
								Text(trigger.summary)
									.maskinText(.caption)
									.foregroundStyle(MaskinColor.ink5)
									.lineLimit(2)
							}
							Spacer(minLength: MaskinSpace.s3)
							Toggle(
								"Enabled",
								isOn: Binding(get: { trigger.enabled }, set: { onToggleTrigger(trigger.id, $0) })
							)
							.labelsHidden()
							.controlSize(.small)
							.accessibilityLabel("\(trigger.name) enabled")
						}
					}
				}
			}
		}
	}

	@ViewBuilder private var setupCards: some View {
		card("Instructions", action: ("Change in chat", "bubble.left", onChangeInChat),
			secondary: onEditInstructions.map { ("Edit", "pencil", $0) }) {
			if let prompt = profile.systemPrompt, !prompt.isEmpty {
				Text(prompt)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(10)
					.frame(maxWidth: .infinity, alignment: .leading)
			} else {
				Text("No instructions yet. Tell this agent what its job is.")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
			}
		}
		card("Tools") {
			if profile.tools.isEmpty {
				Text("No tools connected.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					ForEach(profile.tools) { tool in
						HStack(spacing: MaskinSpace.s5) {
							Image(systemName: "wrench.and.screwdriver")
								.foregroundStyle(MaskinColor.ink4)
								.accessibilityHidden(true)
							Text(tool.name).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
							Spacer(minLength: 0)
							if let kind = tool.kind { MonoLabel(kind) }
						}
					}
				}
			}
		}
		card("Skills") {
			if profile.skills.isEmpty {
				Text("No skills.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					ForEach(profile.skills, id: \.self) { skill in
						HStack(spacing: MaskinSpace.s5) {
							Image(systemName: "sparkles")
								.foregroundStyle(MaskinColor.ink4)
								.accessibilityHidden(true)
							Text(skill).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
							Spacer(minLength: 0)
						}
					}
				}
			}
		}
		if !flows.isEmpty {
			card("Flows") {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					ForEach(flows) { flow in
						HStack(spacing: MaskinSpace.s5) {
							Image(systemName: "arrow.triangle.2.circlepath")
								.foregroundStyle(MaskinColor.ink4)
								.accessibilityHidden(true)
							Text(flow.displayName).maskinText(.subhead).foregroundStyle(MaskinColor.ink2).lineLimit(1)
							Spacer(minLength: 0)
						}
					}
				}
			}
		}
		card("Setup") {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				fact("Model", profile.llmProvider ?? "Workspace default")
			}
		}
	}

	@ViewBuilder private var objectCards: some View {
		card("Driving") {
			if objects.isEmpty {
				Text("Not driving any objects yet.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(spacing: 0) {
					ForEach(objects) { object in
						Button { onOpenObject(object.id) } label: {
							HStack(spacing: MaskinSpace.s5) {
								VStack(alignment: .leading, spacing: MaskinSpace.s1) {
									Text(object.title ?? "Untitled")
										.maskinText(.subhead)
										.foregroundStyle(MaskinColor.ink2)
										.lineLimit(2)
									Text("\(object.type.capitalized) · \(object.status.replacingOccurrences(of: "_", with: " ").capitalized)")
										.maskinText(.caption)
										.foregroundStyle(MaskinColor.ink5)
								}
								Spacer(minLength: 0)
								Image(systemName: "chevron.right")
									.foregroundStyle(MaskinColor.ink5)
									.accessibilityHidden(true)
							}
							.frame(minHeight: MaskinSpace.touchMin)
							.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
						if object.id != objects.last?.id { Divider().overlay(MaskinSurface.separator) }
					}
				}
			}
		}
	}

	@ViewBuilder private var sessionCards: some View {
		card("Recent sessions") {
			if store.sessions.isEmpty {
				Text("No runs yet.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(spacing: 0) {
					ForEach(store.sessions) { session in
						if let onOpenLog {
							Button { onOpenLog(session) } label: {
								HStack {
									SessionRow(session: session)
									Image(systemName: "chevron.right").foregroundStyle(MaskinColor.ink5)
										.accessibilityHidden(true)
								}
							}
							.buttonStyle(.plain)
							.accessibilityHint("Opens the session log")
						} else {
							SessionRow(session: session)
						}
						if session.id != store.sessions.last?.id { Divider().overlay(MaskinSurface.separator) }
					}
				}
			}
		}
	}

	/// Centered identity, then the one prominent action.
	private var hero: some View {
		VStack(spacing: MaskinSpace.s9) {
			ActorAvatar(
				name: profile.name, kind: .agent, size: MaskinSpace.s14 * 2 - MaskinSpace.s2, seed: profile.id,
				mood: AgentMood(store.status))
			VStack(spacing: MaskinSpace.s2) {
				Text(profile.name)
					.maskinText(.title)
					.foregroundStyle(MaskinColor.ink)
					.multilineTextAlignment(.center)
				if let description = profile.description?.trimmingCharacters(in: .whitespacesAndNewlines),
					!description.isEmpty
				{
					Text(description)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.multilineTextAlignment(.center)
				} else {
					Text(profile.role)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.multilineTextAlignment(.center)
				}
				AgentStatusLabel(status: store.status).padding(.top, MaskinSpace.s2)
			}
			.accessibilityElement(children: .combine)
		}
		.frame(maxWidth: .infinity)
		.padding(.vertical, MaskinSpace.s9)
	}

	private func card<Content: View>(
		_ title: String, action: (title: String, symbol: String, run: () -> Void)? = nil,
		secondary: (title: String, symbol: String, run: () -> Void)? = nil,
		@ViewBuilder content: () -> Content
	) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(alignment: .firstTextBaseline) {
				SectionHeader(title)
				if let secondary {
					Spacer(minLength: 0)
					Button(action: secondary.run) {
						Label(secondary.title, systemImage: secondary.symbol).labelStyle(.titleOnly)
					}
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink3)
					.accessibilityLabel("\(secondary.title) \(title.lowercased())")
				}
				if let action {
					if secondary == nil { Spacer(minLength: 0) }
					Button(action: action.run) {
						Label(action.title, systemImage: action.symbol).labelStyle(.titleOnly)
					}
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink3)
					.accessibilityLabel("\(action.title) \(title.lowercased())")
				}
			}
			content()
				.padding(MaskinSpace.s10)
				.frame(maxWidth: .infinity, alignment: .leading)
				.agentSurface()
		}
	}

	private func fact(_ label: String, _ value: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			MonoLabel(label)
			Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
	}
}

private struct LiveSessionRow: View {
	let session: AgentSession
	let onStop: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Text(session.currentActivity ?? (session.isPaused ? "Paused" : "Working…"))
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink2)
				.frame(maxWidth: .infinity, alignment: .leading)
			if !session.prompt.isEmpty {
				Text(session.prompt).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(2)
			}
			Button(role: .destructive, action: onStop) { Label("Stop session", systemImage: "stop.circle") }
				.buttonStyle(.secondaryAction)
		}
	}
}

struct SessionRow: View {
	let session: AgentSession

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s7) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(session.prompt.isEmpty ? "Run" : session.prompt)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(2)
				HStack(spacing: MaskinSpace.s3) {
					RelativeTime(session.activityDate, style: .relative)
					if let duration = session.duration() {
						Text("· \(SessionDuration.format(duration))")
					}
				}
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
			}
			Spacer(minLength: MaskinSpace.s3)
			StatusBadge(session.status)
		}
		.padding(.vertical, MaskinSpace.s5)
		.accessibilityElement(children: .combine)
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

/// The full-screen instructions editor (design 6e): one big text field, Save in the bar.
struct InstructionsEditorSheet: View {
	let agentName: String
	let initial: String
	/// Returns whether the save was accepted; the sheet stays open, keeping the text, if not.
	let onSave: (String) async -> Bool

	@Environment(\.dismiss) private var dismiss
	@State private var text = ""
	@State private var isSaving = false

	var body: some View {
		NavigationStack {
			TextEditor(text: $text)
				.maskinText(.body)
				.scrollContentBackground(.hidden)
				.padding(MaskinSpace.s6)
				.background(MaskinSurface.grouped)
				.navigationTitle("Instructions")
				#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
				#endif
				.toolbar {
					ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
					ToolbarItem(placement: .confirmationAction) {
						Button("Save") { Task { await save() } }
							.disabled(isSaving || text == initial)
					}
				}
				.overlay { if isSaving { ProgressView() } }
		}
		.onAppear { text = initial }
		.accessibilityLabel("Instructions for \(agentName)")
	}

	private func save() async {
		isSaving = true
		defer { isSaving = false }
		if await onSave(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
			MaskinHaptics.play(.success)
			dismiss()
		} else {
			MaskinHaptics.play(.error)
		}
	}
}
