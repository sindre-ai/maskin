import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Manage the MCP servers an agent can use: remove one, add a common one with a tap, or wire a
/// custom URL or command. Every change saves straight away, like toggles in Settings.
struct AgentToolsSheet: View {
	let store: AgentDetailStore
	@Environment(\.dismiss) private var dismiss
	@State private var adding = false
	@State private var toRemove: AgentTool?

	private var tools: [AgentTool] { store.profile?.tools ?? [] }

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s12) {
					connected
					quickAdd
				}
				.padding(MaskinSpace.s9)
				.frame(maxWidth: 640)
				.frame(maxWidth: .infinity)
			}
			.background(MaskinSurface.grouped)
			.navigationTitle("Tools")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
			.navigationDestination(isPresented: $adding) {
				CustomServerForm(existing: tools) { tool in
					let ok = await store.addTool(tool)
					if ok { adding = false }
					return ok
				}
			}
			.confirmationDialog(
				"Remove \(toRemove?.name ?? "this tool")?",
				isPresented: Binding(get: { toRemove != nil }, set: { if !$0 { toRemove = nil } }),
				titleVisibility: .visible, presenting: toRemove
			) { tool in
				Button("Remove", role: .destructive) {
					Task { if await store.removeTool(named: tool.name) { MaskinHaptics.play(.success) } }
				}
			} message: { _ in
				Text("The agent can't use it on its next run.")
			}
		}
	}

	private var connected: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			SectionHeader("Connected")
			if tools.isEmpty {
				Text("No tools yet. Add one below to let this agent act outside Maskin.")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.padding(MaskinSpace.s9)
					.frame(maxWidth: .infinity, alignment: .leading)
					.agentSurface()
			} else {
				VStack(spacing: 0) {
					ForEach(tools) { tool in
						ToolRow(tool: tool) { toRemove = tool }
						if tool.id != tools.last?.id { Divider().overlay(MaskinSurface.separator) }
					}
				}
				.agentSurface()
			}
		}
	}

	private var quickAdd: some View {
		let presets = MCPPreset.available(excluding: tools)
		return VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			SectionHeader("Add")
			VStack(spacing: 0) {
				ForEach(presets) { preset in
					Button {
						Task { if await store.addTool(preset.tool) { MaskinHaptics.play(.success) } }
					} label: {
						HStack(spacing: MaskinSpace.s7) {
							Image(systemName: preset.symbol)
								.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
								.foregroundStyle(MaskinColor.ink2)
								.background(MaskinSurface.fill, in: Circle())
							VStack(alignment: .leading, spacing: MaskinSpace.s1) {
								Text(preset.title).maskinText(.headline).foregroundStyle(MaskinColor.ink)
								Text(preset.detail).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
									.multilineTextAlignment(.leading)
							}
							Spacer(minLength: 0)
							Image(systemName: "plus").foregroundStyle(MaskinColor.ink4)
						}
						.padding(MaskinSpace.s9)
						.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
					.disabled(store.busy != nil)
					Divider().overlay(MaskinSurface.separator)
				}
				Button { adding = true } label: {
					HStack(spacing: MaskinSpace.s7) {
						Image(systemName: "link")
							.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
							.foregroundStyle(MaskinColor.ink2)
							.background(MaskinSurface.fill, in: Circle())
						Text("Custom server…").maskinText(.headline).foregroundStyle(MaskinColor.ink)
						Spacer(minLength: 0)
						Image(systemName: "chevron.right").foregroundStyle(MaskinColor.ink5)
					}
					.padding(MaskinSpace.s9)
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
			}
			.agentSurface()
		}
	}
}

private struct ToolRow: View {
	let tool: AgentTool
	let onRemove: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s7) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(tool.name).maskinText(.headline).foregroundStyle(MaskinColor.ink)
				if let location = tool.location {
					Text(location)
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(1)
						.truncationMode(.middle)
				}
			}
			Spacer(minLength: MaskinSpace.s3)
			if let kind = tool.kind { MonoLabel(kind) }
			Button(role: .destructive, action: onRemove) {
				Image(systemName: "minus.circle")
					.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
			}
			.buttonStyle(.plain)
			.foregroundStyle(MaskinColor.ink4)
			.accessibilityLabel("Remove \(tool.name)")
		}
		.padding(.leading, MaskinSpace.s9)
		.accessibilityElement(children: .contain)
	}
}

/// A custom MCP server: a hosted URL, or a local command.
private struct CustomServerForm: View {
	let existing: [AgentTool]
	let onAdd: (AgentTool) async -> Bool
	@State private var draft = MCPServerDraft()
	@State private var error: String?
	@State private var saving = false

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				Picker("Type", selection: $draft.kind) {
					Text("Hosted URL").tag(MCPServerDraft.Kind.http)
					Text("Command").tag(MCPServerDraft.Kind.stdio)
				}
				.pickerStyle(.segmented)
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					TextField("Name", text: $draft.name)
					Divider().overlay(MaskinSurface.separator)
					switch draft.kind {
					case .http:
						TextField("https://example.com/mcp", text: $draft.url)
							#if os(iOS)
							.keyboardType(.URL)
							.textInputAutocapitalization(.never)
							#endif
							.autocorrectionDisabled()
					case .stdio:
						TextField("Command (e.g. npx)", text: $draft.command)
							#if os(iOS)
							.textInputAutocapitalization(.never)
							#endif
							.autocorrectionDisabled()
						Divider().overlay(MaskinSurface.separator)
						TextField("Arguments", text: $draft.args)
							#if os(iOS)
							.textInputAutocapitalization(.never)
							#endif
							.autocorrectionDisabled()
					}
				}
				.maskinText(.body)
				.padding(MaskinSpace.s9)
				.agentSurface()
				Text("Secrets belong in the web app's environment settings. Use \u{24}{NAME} placeholders, never paste a token here.")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink5)
				FormError(error)
				Button(saving ? "Adding…" : "Add server") { Task { await add() } }
					.buttonStyle(.primaryAction)
					.disabled(saving)
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 640)
			.frame(maxWidth: .infinity)
		}
		.background(MaskinSurface.grouped)
		.navigationTitle("Custom server")
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
	}

	private func add() async {
		switch draft.build(existing: existing) {
		case .failure(let failure):
			error = failure.message
			MaskinHaptics.play(.error)
		case .success(let tool):
			error = nil
			saving = true
			defer { saving = false }
			if !(await onAdd(tool)) { error = "Couldn't save. Try again." }
		}
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
