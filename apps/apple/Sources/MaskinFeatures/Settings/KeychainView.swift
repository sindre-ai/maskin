import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Keychain (the web's Settings → Keychain): the credentials your agents use to reach outside
/// services. Each is encrypted at rest, shared with specific agents, and every use is logged. The
/// value itself never comes to the app. Tap one to change who can use it, read its activity, or
/// remove it; add a key or a login with +.
struct KeychainView: View {
	@State private var store: KeychainStore
	@State private var selected: KeychainCredential?
	@State private var adding = false

	init(store: KeychainStore) { _store = State(initialValue: store) }

	var body: some View {
		WorkspacePage(title: "Keychain") {
			if store.credentials.isEmpty {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				case .loaded:
					PageStatus(
						text: "No credentials yet. Add a key or a login, or paste one into a chat and Maskin vaults it for you."
					)
				default: PageStatus(text: "Loading your credentials")
				}
			} else {
				PageCard(rows: rows)
			}
			if let error = store.actionError { FormError(error) }
			PageFootnote(
				text:
					"Credentials your agents use to reach external services. Each is encrypted at rest, shared with specific agents, and every use is logged."
			)
		}
		.task { await store.load() }
		.refreshable { await store.load() }
		.toolbar {
			ToolbarItem(placement: .primaryAction) {
				Button { adding = true } label: { Label("Add credential", systemImage: "plus") }
			}
		}
		.sheet(item: $selected) { credential in
			KeychainDetailView(store: store, credentialID: credential.id)
		}
		.sheet(isPresented: $adding) { AddCredentialView(store: store) }
	}

	private var rows: [PageRowModel] {
		store.credentials.map { credential in
			PageRowModel(
				id: credential.id, title: credential.name,
				subtitle: "\(credential.kindLabel) · \(store.scopeSummary(credential))"
					+ (credential.capturedViaChat ? " · captured via chat" : ""),
				accessory: .state(
					store.agentsWithAccess(credential).isEmpty
						? PageState("Unassigned", .muted) : PageState("Assigned", .active)),
				showsChevron: true, action: { selected = credential })
		}
	}
}

/// One credential: who may use it, what has happened with it, and removing it.
struct KeychainDetailView: View {
	@Environment(\.dismiss) private var dismiss
	let store: KeychainStore
	let credentialID: String
	@State private var chosen: Set<String> = []
	@State private var seeded = false
	@State private var confirmRemove = false

	var body: some View {
		NavigationStack {
			Group {
				if let credential = store.credential(credentialID) {
					List {
						Section {
							LabeledContent("Type", value: credential.kindLabel)
							if let date = credential.createdAt {
								LabeledContent("Added", value: date.formatted(date: .abbreviated, time: .shortened))
							}
							if credential.capturedViaChat {
								LabeledContent("Source", value: "Captured via chat")
							}
						}
						access(credential)
						activity(credential)
						if store.canRemove(credential) {
							Section {
								Button("Remove credential", role: .destructive) { confirmRemove = true }
							} footer: {
								Text("The secret is destroyed. Agents that used it lose access at once.")
							}
						}
					}
					.task(id: credentialID) {
						if !seeded {
							chosen = Set(store.agentsWithAccess(credential).map(\.id))
							seeded = true
						}
						await store.loadAudit(for: credential)
					}
					.confirmationDialog(
						"Remove \(credential.name)?", isPresented: $confirmRemove, titleVisibility: .visible
					) {
						Button("Remove", role: .destructive) {
							Task { if await store.remove(credential) { dismiss() } }
						}
					} message: {
						Text("The secret is destroyed and can't be recovered.")
					}
				} else {
					PageStatus(text: "This credential is no longer in the Keychain.")
				}
			}
			.navigationTitle(store.credential(credentialID)?.name ?? "Credential")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
		}
	}

	@ViewBuilder
	private func access(_ credential: KeychainCredential) -> some View {
		Section {
			if store.agents.isEmpty {
				Text("No agents in this workspace.").foregroundStyle(MaskinColor.ink4)
			}
			if credential.canEditAccess {
				ForEach(store.agents) { agent in
					Toggle(
						agent.name,
						isOn: Binding(
							get: { chosen.contains(agent.id) },
							set: { on in if on { chosen.insert(agent.id) } else { chosen.remove(agent.id) } }))
				}
				if chosen != Set(store.agentsWithAccess(credential).map(\.id)) {
					Button("Save access") { Task { await store.setAccess(of: credential, to: chosen) } }
						.disabled(store.isBusy)
				}
			} else {
				// Read-only: an OAuth connection is managed under Integrations, and one still inside its
				// undo window can't be shared yet (the server refuses both).
				ForEach(store.agentsWithAccess(credential)) { Text($0.name) }
			}
			if let error = store.actionError { FormError(error) }
		} header: {
			Text("Who can use it")
		} footer: {
			Text(accessFooter(credential))
		}
	}

	private func accessFooter(_ credential: KeychainCredential) -> String {
		if !credential.canEditAccess {
			return credential.kind == .oauth
				? "This connection is managed under Integrations."
				: "You can choose who can use it once it is saved for good."
		}
		if credential.defaultOn { return "Every agent can use this by default. Untick an agent to block it." }
		return chosen.isEmpty
			? "No agents can use this credential yet."
			: "These agents get read-and-write access to use it, in any chat or run."
	}

	@ViewBuilder
	private func activity(_ credential: KeychainCredential) -> some View {
		Section("Activity") {
			if store.audit.isEmpty {
				Text(store.auditFailed ? "Couldn't load the activity." : "No activity yet.")
					.foregroundStyle(MaskinColor.ink4)
			}
			ForEach(store.audit) { entry in
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text(store.sentence(for: entry)).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
					if let at = entry.at {
						Text(at.formatted(date: .abbreviated, time: .shortened))
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
				}
			}
			if store.auditNext != nil {
				Button("Load more") { Task { await store.loadAudit(for: credential, more: true) } }
			}
		}
	}
}

/// Add a key or a login. The value goes straight to the encrypted vault and is cleared from the
/// screen as soon as it is saved. Opened from a pasted secret in a chat, it arrives with the key and a
/// name filled in and the chat's agents ticked, so one tap vaults it and shares it.
struct AddCredentialView: View {
	/// A secret caught in a chat: shown masked, never in full.
	struct Prefill {
		var name: String
		var secret: String
		var masked: String
	}

	@Environment(\.dismiss) private var dismiss
	let store: KeychainStore
	let prefill: Prefill?
	let onSaved: ((String) -> Void)?
	@State private var isLogin = false
	@State private var name: String
	@State private var secret: String
	@State private var username = ""
	@State private var password = ""
	@State private var sharedWith: Set<String>

	init(store: KeychainStore, prefill: Prefill? = nil, shareWith: Set<String> = [], onSaved: ((String) -> Void)? = nil) {
		self.store = store
		self.prefill = prefill
		self.onSaved = onSaved
		_name = State(initialValue: prefill?.name ?? "")
		_secret = State(initialValue: prefill?.secret ?? "")
		_sharedWith = State(initialValue: shareWith)
	}

	var body: some View {
		NavigationStack {
			Form {
				Section {
					if prefill == nil {
						Picker("Type", selection: $isLogin) {
							Text("API key").tag(false)
							Text("Login").tag(true)
						}
						.pickerStyle(.segmented)
					}
					TextField("Name, e.g. e-conomic", text: $name)
					if isLogin {
						TextField("Username", text: $username).textContentType(.username)
						SecureField("Password", text: $password).textContentType(.password)
					} else if let prefill {
						LabeledContent("Key", value: prefill.masked)
					} else {
						SecureField("Paste the key", text: $secret).textContentType(.password)
					}
				} footer: {
					Text(
						prefill == nil
							? "It goes straight to your encrypted vault. After saving, choose which agents can use it from the credential's page."
							: "It goes straight to your encrypted vault and is replaced in your message by a marker, so it never appears in the chat.")
				}
				if !store.agents.isEmpty {
					Section {
						ForEach(store.agents) { agent in
							Toggle(
								agent.name,
								isOn: Binding(
									get: { sharedWith.contains(agent.id) },
									set: { on in if on { sharedWith.insert(agent.id) } else { sharedWith.remove(agent.id) } }))
						}
					} header: {
						Text("Who can use it")
					} footer: {
						Text(sharedWith.isEmpty ? "No agents can use it yet. You can change this later." : "")
					}
				}
				if let message = nameProblem ?? store.actionError {
					Section { FormError(message) }
				}
			}
			.navigationTitle(prefill == nil ? "Add credential" : "Save to Keychain")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				if prefill == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") { Task { await save() } }.disabled(!canSave)
				}
			}
			.task { if store.agents.isEmpty { await store.load() } }
		}
	}

	private var nameProblem: String? {
		name.trimmingCharacters(in: .whitespaces).isEmpty ? nil : KeychainCredentialName.problem(name)
	}

	private var canSave: Bool {
		!store.isBusy && nameProblem == nil && !name.trimmingCharacters(in: .whitespaces).isEmpty
			&& (isLogin ? !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty : !secret.isEmpty)
	}

	private func save() async {
		let value: KeychainNewValue =
			isLogin ? .login(username: username.trimmingCharacters(in: .whitespaces), password: password) : .apiKey(secret)
		let saveName = name.trimmingCharacters(in: .whitespacesAndNewlines)
		let ids = store.agents.map(\.id).filter(sharedWith.contains)
		let outcome = await store.add(name: saveName, value: value, agentIDs: ids)
		// Only a saved credential clears what was typed: a refused save (name taken, offline) keeps
		// the fields so nothing has to be typed or pasted again.
		guard outcome.didSave else { return }
		// The value is gone from the screen the moment it is saved.
		secret = ""
		password = ""
		username = ""
		onSaved?(saveName)
		dismiss()
	}
}
