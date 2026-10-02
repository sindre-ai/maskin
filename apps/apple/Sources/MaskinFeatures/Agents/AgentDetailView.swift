import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One agent: who it is, what it's doing, how to run it, and its recent sessions. Editing the
/// instructions or tools happens on the web for now; everything here is read-only except the
/// run/pause/reset/stop actions.
struct AgentDetailView: View {
	let store: AgentDetailStore
	@State private var showRun = false
	@State private var confirmReset = false
	@State private var sessionToStop: AgentSession?

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s11) {
				if let profile = store.profile {
					AgentDetailContent(
						profile: profile, store: store,
						onRun: { runTapped() },
						onPause: { Task { await store.pause() } },
						onReset: { confirmReset = true },
						onStop: { sessionToStop = $0 })
				} else {
					placeholder
				}
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 720, alignment: .leading)
			.frame(maxWidth: .infinity)
		}
		.background(MaskinSurface.grouped)
		.navigationTitle(store.profile?.name ?? "Agent")
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.refreshable { await store.refresh() }
		.sheet(isPresented: $showRun) {
			RunAgentSheet(agentName: store.profile?.name ?? "this agent") { prompt in
				await store.run(prompt: prompt)
			}
			.presentationDetents([.medium, .large])
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

	var body: some View {
		header
		actions
		if let live = store.liveSession {
			card("Now") { LiveSessionRow(session: live) { onStop(live) } }
		}
		if let prompt = profile.systemPrompt, !prompt.isEmpty {
			card("Instructions") {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					Text(prompt)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink2)
						.lineLimit(12)
						.frame(maxWidth: .infinity, alignment: .leading)
					Text("Edit instructions on the web.")
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.ink5)
				}
			}
		}
		card("Setup") {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				fact("Model", profile.llmProvider ?? "Workspace default")
				fact("Tools", profile.tools.isEmpty ? "None connected" : profile.tools.map(\.name).joined(separator: ", "))
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

	private var header: some View {
		HStack(spacing: MaskinSpace.s9) {
			ActorAvatar(
				name: profile.name, kind: .agent, size: MaskinSpace.s14 * 2, seed: profile.id,
				working: store.status == .running)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(profile.name).maskinText(.title).foregroundStyle(MaskinColor.ink)
				Text(profile.role).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				AgentStatusLabel(status: store.status)
			}
			Spacer(minLength: 0)
		}
		.accessibilityElement(children: .combine)
	}

	private var actions: some View {
		ViewThatFits(in: .horizontal) {
			HStack(spacing: MaskinSpace.s5) { actionButtons }
			VStack(spacing: MaskinSpace.s5) { actionButtons }
		}
	}

	@ViewBuilder
	private var actionButtons: some View {
		if AgentActions.canPause(store.status) {
			Button(action: onPause) { Label(store.busy == .pause ? "Pausing…" : "Pause", systemImage: "pause.circle") }
				.buttonStyle(.secondaryAction)
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
		if AgentActions.canReset(isSystem: profile.isSystem) {
			Button(action: onReset) { Label("Reset", systemImage: "arrow.counterclockwise") }
				.buttonStyle(.secondaryAction)
				.disabled(!store.canReset)
		}
	}

	private func card<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader(title)
			content()
				.padding(MaskinSpace.s9)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card))
				.overlay(RoundedRectangle(cornerRadius: MaskinRadius.card).strokeBorder(MaskinSurface.line))
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
