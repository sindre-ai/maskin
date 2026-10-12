import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Adds an existing person by the ID shown on their Profile screen.
struct AddMemberSheet: View {
	@Environment(\.dismiss) private var dismiss
	let store: MembersStore
	@State private var actorId = ""
	@State private var role: MemberRole = .member

	private var canSubmit: Bool { MembersStore.isValidActorId(actorId) && !store.isAdding }

	var body: some View {
		NavigationStack {
			Form {
				Section {
					TextField("Their ID", text: $actorId)
						.font(.system(.body, design: .monospaced))
						#if os(iOS)
							.textInputAutocapitalization(.never)
						#endif
						.autocorrectionDisabled()
						.submitLabel(.done)
						.frame(minHeight: MaskinSpace.touchMin)
				} header: {
					Text("Person")
				} footer: {
					Text("They open Settings, then Profile, and copy their ID to send to you.")
				}
				Section("Role") {
					Picker("Role", selection: $role) {
						ForEach([MemberRole.member, .admin], id: \.self) { Text($0.label).tag($0) }
					}
					.pickerStyle(.segmented)
				}
				if let error = store.actionError { Section { FormError(error) } }
			}
			.settingsListStyle()
			.navigationTitle("Add member")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Add") {
						Task { if await store.add(actorId: actorId, role: role) { dismiss() } }
					}
					.disabled(!canSubmit)
				}
			}
			.overlay { if store.isAdding { ProgressView() } }
			.onAppear { store.dismissError() }
		}
		.presentationDetents([.medium, .large])
	}
}
