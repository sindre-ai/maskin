import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Create a new agent, or edit an existing one's name, one-line role and instructions. One
/// sheet for both so the two can never drift apart.
struct AgentFormSheet: View {
	enum Mode: Equatable {
		case create
		case edit
	}

	let mode: Mode
	@State private var draft: AgentDraft
	/// Returns whether the change was accepted; the sheet stays open (keeping the text) if not.
	let onSubmit: (AgentDraft) async -> Bool
	/// Error text from the store, shown under the form.
	var errorMessage: String?

	@Environment(\.dismiss) private var dismiss
	@State private var isSaving = false
	@FocusState private var focus: Field?

	private enum Field { case name, role, instructions }

	init(
		mode: Mode, initial: AgentDraft = AgentDraft(), errorMessage: String? = nil,
		onSubmit: @escaping (AgentDraft) async -> Bool
	) {
		self.mode = mode
		_draft = State(initialValue: initial)
		self.errorMessage = errorMessage
		self.onSubmit = onSubmit
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s12) {
					if mode == .create { intro }
					field("Name") {
						TextField("Forge", text: $draft.name)
							.focused($focus, equals: .name)
							.submitLabel(.next)
							.onSubmit { focus = .role }
					}
					field("Role", footer: "One line shown in the agents list.") {
						TextField("Ships fixes and keeps CI green", text: $draft.description, axis: .vertical)
							.lineLimit(1...3)
							.focused($focus, equals: .role)
					}
					field("Instructions", footer: "What this agent does every time it runs.") {
						TextField("Describe how it should work…", text: $draft.systemPrompt, axis: .vertical)
							.lineLimit(8...30)
							.focused($focus, equals: .instructions)
							.font(MaskinTypeface.mono(MaskinFontSize.t13, relativeTo: .footnote))
					}
					FormError(errorMessage)
				}
				.padding(MaskinSpace.s9)
				.frame(maxWidth: 640)
				.frame(maxWidth: .infinity)
			}
			.scrollDismissesKeyboard(.interactively)
			.background(MaskinSurface.grouped)
			.navigationTitle(mode == .create ? "New agent" : "Edit agent")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button(mode == .create ? "Create" : "Save") { Task { await submit() } }
						.disabled(!draft.isValid || isSaving)
				}
			}
			.overlay { if isSaving { ProgressView() } }
			.interactiveDismissDisabled(isSaving)
		}
		.onAppear { if mode == .create { focus = .name } }
	}

	private var intro: some View {
		VStack(spacing: MaskinSpace.s5) {
			ActorAvatar(
				name: draft.trimmedName.isEmpty ? "New agent" : draft.trimmedName, kind: .agent,
				size: MaskinSpace.s14 * 2, seed: draft.trimmedName)
			Text("Give it one job and clear instructions. You can connect tools afterwards.")
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink4)
				.multilineTextAlignment(.center)
		}
		.frame(maxWidth: .infinity)
		.padding(.top, MaskinSpace.s5)
	}

	private func field<Content: View>(
		_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content
	) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			SectionHeader(title)
			content()
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.padding(MaskinSpace.s9)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
				.overlay(
					RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
						.strokeBorder(MaskinSurface.line))
			if let footer {
				Text(footer).maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					.padding(.horizontal, MaskinSpace.s4)
			}
		}
	}

	private func submit() async {
		isSaving = true
		defer { isSaving = false }
		if await onSubmit(draft) {
			MaskinHaptics.play(.success)
			dismiss()
		} else {
			MaskinHaptics.play(.error)
		}
	}
}
