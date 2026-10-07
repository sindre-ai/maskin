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
	@State private var showRun = false
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var confirmReset = false
	@State private var confirmDelete = false
	@State private var sessionToStop: AgentSession?

	/// Agents are changed by talking to someone, not through a form.
	private func changeInChat() {
		guard let name = store.profile?.name else { return }
		runtime?.buildInChat("I'd like to change the agent \(name). ")
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				if let profile = store.profile {
					AgentDetailContent(
						profile: profile, store: store,
						onRun: { runTapped() },
						onPause: { Task { await store.pause() } },
						onReset: { confirmReset = true },
						onStop: { sessionToStop = $0 },
						onChangeInChat: { changeInChat() })
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
				ToolbarItem(placement: .primaryAction) {
					Menu {
						Button { changeInChat() } label: { Label("Change in chat", systemImage: "bubble.left") }
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
	var onRun: () -> Void = {}
	var onPause: () -> Void = {}
	var onReset: () -> Void = {}
	var onStop: (AgentSession) -> Void = { _ in }
	var onChangeInChat: () -> Void = {}

	var body: some View {
		hero
		if let live = store.liveSession {
			card("Now") { LiveSessionRow(session: live) { onStop(live) } }
		}
		card("Instructions", action: ("Change in chat", "bubble.left", onChangeInChat)) {
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
		card("Setup") {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				fact("Model", profile.llmProvider ?? "Workspace default")
				fact("Skills", profile.skills.isEmpty ? "None" : profile.skills.joined(separator: ", "))
			}
		}
		card("Recent sessions") {
			if store.sessions.isEmpty {
				Text("No runs yet.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(spacing: 0) {
					ForEach(store.sessions) { session in
						SessionRow(session: session)
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
				name: profile.name, kind: .agent, size: MaskinSpace.s14 * 3, seed: profile.id,
				mood: AgentMood(store.status))
			VStack(spacing: MaskinSpace.s2) {
				Text(profile.name)
					.maskinText(.title)
					.foregroundStyle(MaskinColor.ink)
					.multilineTextAlignment(.center)
				Text(profile.role)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.multilineTextAlignment(.center)
					.lineLimit(2)
				AgentStatusLabel(status: store.status).padding(.top, MaskinSpace.s2)
			}
			.accessibilityElement(children: .combine)
			actions
		}
		.frame(maxWidth: .infinity)
		.padding(.vertical, MaskinSpace.s9)
	}

	private var actions: some View {
		ViewThatFits(in: .horizontal) {
			HStack(spacing: MaskinSpace.s5) { actionButtons }
			VStack(spacing: MaskinSpace.s5) { actionButtons }
		}
		.frame(maxWidth: 420)
	}

	@ViewBuilder
	private var actionButtons: some View {
		if AgentActions.canPause(store.status) {
			Button(action: onPause) { Label(store.busy == .pause ? "Pausing…" : "Pause", systemImage: "pause.fill") }
				.buttonStyle(.primaryAction)
				.disabled(!store.canPause)
		} else {
			Button(action: onRun) {
				Label(
					store.busy == .run ? "Starting…" : (store.status == .paused ? "Resume" : "Run now"),
					systemImage: "play.fill")
			}
			.buttonStyle(.primaryAction)
			.disabled(!store.canRun)
		}
	}

	private func card<Content: View>(
		_ title: String, action: (title: String, symbol: String, run: () -> Void)? = nil,
		@ViewBuilder content: () -> Content
	) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(alignment: .firstTextBaseline) {
				SectionHeader(title)
				if let action {
					Spacer(minLength: 0)
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
