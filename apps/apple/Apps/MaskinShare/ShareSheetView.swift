import ImageIO
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

#if canImport(UIKit)
	import UIKit
#elseif canImport(AppKit)
	import AppKit
#endif

/// The share sheet. Pure SwiftUI over `ShareSheetModel`; the view controller supplies the host
/// integration (closing, opening the app) as closures, so this file renders in previews and
/// snapshot tests without an extension context.
struct ShareSheetView: View {
	@Bindable var model: ShareSheetModel
	/// Finished (Done): the share is complete or saved.
	var onClose: () -> Void
	/// Backed out (Cancel): the host app is told the user cancelled.
	var onCancel: () -> Void = {}
	var onOpen: (URL) -> Void

	/// The form, or one of the two pushed screens inside the sheet.
	private enum Screen { case form, agents, chats }

	@State private var screen: Screen = .form
	@State private var agentQuery = ""
	@FocusState private var noteFocused: Bool
	@State private var confirmingDiscard = false
	@ScaledMetric(relativeTo: .title) private var heroIconSize: CGFloat = 56
	@ScaledMetric(relativeTo: .title) private var blockedIconSize: CGFloat = 44

	var body: some View {
		VStack(spacing: 0) {
			header
			switch model.phase {
			case .loading:
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			case .blocked(let error):
				blocked(error)
			case .posted:
				posted
			case .queued:
				queued
			case .ready, .posting, .failed:
				switch screen {
				case .form: form
				case .agents: agentPicker
				case .chats: chatPicker
				}
			}
		}
		.ambientBackground(showsBottom: false)
		.task { await model.start() }
		.onChange(of: model.phase) { _, phase in
			switch phase {
			case .posted:
				MaskinHaptics.play(.success)
				AccessibilityNotification.Announcement(model.successTitle).post()
			case .queued:
				MaskinHaptics.play(.success)
				AccessibilityNotification.Announcement(
					model.isNewChat
						? "Saved for later. Maskin will start the chat from the app."
						: "Saved for later. Maskin will send it from the app."
				).post()
			case .failed(let error):
				MaskinHaptics.play(.error)
				AccessibilityNotification.Announcement("Couldn't send. \(error.message)").post()
			default: break
			}
		}
		.onChange(of: model.title) { _, _ in model.saveDraft() }
		.onChange(of: model.note) { _, _ in model.saveDraft() }
		.confirmationDialog("Close without sending?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
			Button("Keep draft and close") { onCancel() }
			Button("Discard", role: .destructive) {
				model.discardDraft()
				onCancel()
			}
			Button("Keep editing", role: .cancel) {}
		} message: {
			Text("Your note is saved, so it will be here if you share this again.")
		}
	}

	// MARK: Header

	/// Cancel on the left, "Maskin" in the middle, Send on the right (text, as in the v3 design).
	/// After sending, Done replaces Cancel and Send goes away.
	private var header: some View {
		HStack {
			Button(isPushed ? "Back" : (isDone ? "Done" : "Cancel"), action: headerAction)
				.maskinText(.headline)
				.fontWeight(.regular)
				.foregroundStyle(MaskinColor.ink3)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				.frame(maxWidth: .infinity, alignment: .leading)
			Text(headerTitle)
				.maskinText(.headline)
				.foregroundStyle(MaskinColor.ink)
				.accessibilityAddTraits(.isHeader)
			Group {
				if showsForm, !isPushed { sendButton } else { Color.clear.frame(height: MaskinSpace.touchMin) }
			}
			.frame(maxWidth: .infinity, alignment: .trailing)
		}
		.padding(.horizontal, MaskinSpace.s10)
		.padding(.top, MaskinSpace.s2)
	}

	private var showsForm: Bool {
		switch model.phase {
		case .ready, .posting, .failed: true
		default: false
		}
	}

	private func copyToPasteboard(_ text: String) {
		#if canImport(UIKit)
			UIPasteboard.general.string = text
		#elseif canImport(AppKit)
			NSPasteboard.general.clearContents()
			NSPasteboard.general.setString(text, forType: .string)
		#endif
	}

	/// One of the pushed screens (the agent picker, the existing chats) is showing.
	private var isPushed: Bool { showsForm && screen != .form }

	private var headerTitle: String {
		guard isPushed else { return "Maskin" }
		return screen == .agents ? "Choose an agent" : "Existing chats"
	}

	private func headerAction() {
		if isPushed {
			screen = .form
		} else if isDone {
			onClose()
		} else if isPosting {
			// Stop the upload, then leave: the parked files are removed with the sheet.
			model.cancelPosting()
			onCancel()
		} else if model.hasUnsentText {
			confirmingDiscard = true
		} else {
			onCancel()
		}
	}

	private var isPosting: Bool { if case .posting = model.phase { true } else { false } }
	private var isDone: Bool {
		switch model.phase {
		case .posted, .queued: true
		default: false
		}
	}

	// MARK: Composer

	private var form: some View {
		VStack(spacing: MaskinSpace.s6) {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s6) {
					composer
					ForEach(model.content.skipped.indices, id: \.self) { index in
						Label(model.content.skipped[index].message, systemImage: "exclamationmark.circle")
							.maskinText(.caption)
							.foregroundStyle(MaskinColor.ink4)
							.padding(.horizontal, MaskinSpace.s4)
					}
					if case .failed(let error) = model.phase {
						FormError(error.message).frame(maxWidth: .infinity, alignment: .leading)
						if model.createdObjectBeforeFailure, error.isRetryable {
							Text("Your item was already created. Trying again only finishes what's missing.")
								.maskinText(.caption)
								.foregroundStyle(MaskinColor.ink4)
								.padding(.horizontal, MaskinSpace.s4)
						}
						if model.isNewChat, model.uploadedFilesBeforeFailure, error.isRetryable {
							Text("Your files are already uploaded. Trying again only finishes the chat.")
								.maskinText(.caption)
								.foregroundStyle(MaskinColor.ink4)
								.padding(.horizontal, MaskinSpace.s4)
						}
					}
				}
				.padding(.horizontal, MaskinSpace.s10)
			}
			.scrollDismissesKeyboard(.interactively)
		}
		.padding(.bottom, MaskinSpace.s6)
	}

	/// What is shared, the To row (and a Workspace row when the person is in more than one), the
	/// note and the link to an existing chat.
	private var composer: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			SharePreviewCard(content: model.content)
			if model.showsTitleField {
				TextField("Title", text: $model.title, axis: .vertical)
					.lineLimit(1...3)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.padding(.horizontal, MaskinSpace.s4)
					.accessibilityLabel("Title")
					.disabled(isPosting)
			}
			destinationRows
			Text(model.isLoadingAgents ? "Loading agents" : (model.isNewChat ? "Starts a new chat" : "Adds to this chat"))
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
				.padding(.horizontal, MaskinSpace.s4)
			TextField(notePlaceholder, text: $model.note, axis: .vertical)
				.lineLimit(3...8)
				.focused($noteFocused)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.padding(MaskinSpace.s7)
				.frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
				.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				.accessibilityLabel(model.isNewChat ? "Message to the agent" : "Message")
				.disabled(isPosting)
			if !model.conversations.isEmpty {
				Button("Add to an existing chat instead") {
					screen = .chats
					MaskinHaptics.play(.selection)
				}
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink3)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				.padding(.horizontal, MaskinSpace.s4)
				.disabled(isPosting)
			}
		}
	}

	private var notePlaceholder: String {
		guard model.isNewChat else { return "Add a message" }
		return "Tell \(model.selectedAgent?.name ?? "the agent") what to do with this"
	}

	/// "To" (the agent, or the existing chat) with a "Workspace" row when the person has more than
	/// one. A row opens a pushed screen or a menu, so it has a chevron.
	private var destinationRows: some View {
		VStack(spacing: 0) {
			toRow
			if model.workspaces.count > 1, let name = model.workspace?.name {
				Divider().overlay(MaskinSurface.line)
				workspaceRow(name)
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
	}

	private func row(_ name: String, value: String, agent: ShareAgent? = nil) -> some View {
		HStack(spacing: MaskinSpace.s4) {
			Text(name).maskinText(.body).foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: MaskinSpace.s4)
			if let agent { ActorAvatar(name: agent.name, kind: .agent, size: 24, seed: agent.id) }
			Text(value).maskinText(.body).fontWeight(.medium).foregroundStyle(MaskinColor.ink).lineLimit(1)
			Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(MaskinColor.ink4)
		}
		.padding(.horizontal, MaskinSpace.s7)
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
	}

	private var toRow: some View {
		let value = model.isLoadingAgents ? "Loading agents" : model.label(for: model.destination)
		return Button {
			agentQuery = ""
			screen = .agents
			MaskinHaptics.play(.selection)
		} label: {
			row("To", value: value, agent: model.isLoadingAgents ? nil : model.selectedAgent)
		}
		.buttonStyle(.plain)
		.disabled(isPosting || model.isLoadingAgents)
		.accessibilityLabel("To: \(value)")
		.accessibilityHint("Double tap to choose an agent")
	}

	private func workspaceRow(_ name: String) -> some View {
		Menu {
			ForEach(model.workspaces, id: \.id) { workspace in
				Button {
					Task { await model.selectWorkspace(workspace.id) }
				} label: {
					if workspace.id == model.activeWorkspaceId {
						Label(workspace.name, systemImage: "checkmark")
					} else {
						Text(workspace.name)
					}
				}
			}
		} label: {
			row("Workspace", value: name)
		}
		.disabled(isPosting)
		.accessibilityLabel("Workspace: \(name)")
	}

	// MARK: Pushed screens

	/// "Choose an agent": search, RECENT and ALL AGENTS (or N MATCHES while searching).
	private var agentPicker: some View {
		let searching = !agentQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		let matches = model.agents(matching: agentQuery)
		return VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			TextField("Search agents", text: $agentQuery)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.padding(MaskinSpace.s7)
				.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				.submitLabel(.done)
				.onSubmit { if let first = matches.first { pick(first) } }
				.accessibilityLabel("Search agents")
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 0) {
					if searching {
						MonoLabel(matches.count == 1 ? "1 MATCH" : "\(matches.count) MATCHES")
						if matches.isEmpty {
							Text("No agent matches \u{201C}\(agentQuery.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}. Try a role, like Researcher or CPO.")
								.maskinText(.body)
								.foregroundStyle(MaskinColor.ink4)
								.padding(.top, MaskinSpace.s5)
						}
						ForEach(matches) { agentRow($0) }
					} else {
						if !model.recentAgents.isEmpty {
							MonoLabel("RECENT")
							ForEach(model.recentAgents) { agentRow($0) }
						}
						MonoLabel("ALL AGENTS").padding(.top, MaskinSpace.s5)
						ForEach(model.agents) { agentRow($0) }
					}
				}
			}
			.scrollDismissesKeyboard(.interactively)
		}
		.padding(.horizontal, MaskinSpace.s10)
		.padding(.bottom, MaskinSpace.s6)
	}

	private func agentRow(_ agent: ShareAgent) -> some View {
		Button {
			pick(agent)
		} label: {
			HStack(spacing: MaskinSpace.s7) {
				ActorAvatar(name: agent.name, kind: .agent, size: 32, seed: agent.id)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(agent.name).maskinText(.body).foregroundStyle(MaskinColor.ink)
					if let role = agent.role, !role.isEmpty {
						Text(role).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					}
				}
				Spacer(minLength: MaskinSpace.s4)
				if model.selectedAgent?.id == agent.id {
					Image(systemName: "checkmark").foregroundStyle(MaskinColor.ink)
				}
			}
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(agent.role.map { "\(agent.name), \($0)" } ?? agent.name)
		.accessibilityAddTraits(model.selectedAgent?.id == agent.id ? .isSelected : [])
	}

	private func pick(_ agent: ShareAgent) {
		model.selectAgent(agent.id)
		MaskinHaptics.play(.selection)
		screen = .form
	}

	/// "Existing chats": the newest chats of the workspace.
	private var chatPicker: some View {
		ScrollView {
			LazyVStack(alignment: .leading, spacing: 0) {
				MonoLabel("RECENT")
				ForEach(model.conversations) { conversation in
					Button {
						model.selectConversation(conversation.id)
						MaskinHaptics.play(.selection)
						screen = .form
					} label: {
						HStack {
							Text(conversation.title).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
							Spacer(minLength: MaskinSpace.s4)
							if model.destination == .chat(id: conversation.id) {
								Image(systemName: "checkmark").foregroundStyle(MaskinColor.ink)
							}
						}
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityAddTraits(model.destination == .chat(id: conversation.id) ? .isSelected : [])
				}
			}
			.padding(.horizontal, MaskinSpace.s10)
		}
		.padding(.bottom, MaskinSpace.s6)
	}

	/// The text Send in the header. Spinner while a post is in flight; after a failure it is Try
	/// again.
	private var sendButton: some View {
		Button {
			noteFocused = false
			Task { await model.post() }
		} label: {
			Group {
				if isPosting {
					ProgressView()
				} else {
					Text(failedRetry ? "Try again" : "Send")
				}
			}
			.maskinText(.headline)
			.foregroundStyle(MaskinColor.ink)
			.frame(minHeight: MaskinSpace.touchMin)
			.opacity(model.canPost || isPosting ? 1 : 0.4)
		}
		.buttonStyle(.maskinPressed)
		.disabled(!model.canPost)
		.accessibilityLabel(sendLabel)
	}

	private var failedRetry: Bool {
		if case .failed(let error) = model.phase { error.isRetryable } else { false }
	}

	private var sendLabel: String {
		if model.isLoadingSchema { return "Loading workspace" }
		switch model.phase {
		case .posting(let step):
			if case .uploading(let index, let total)? = step, total > 1 { return "Uploading \(index) of \(total)" }
			if case .startingChat? = step { return "Starting chat" }
			return "Sending"
		case .failed(let error): return error.isRetryable ? "Try again" : "Send to Maskin"
		default: return "Send to Maskin"
		}
	}

	// MARK: Terminal states

	private var posted: some View {
		VStack(spacing: MaskinSpace.s11) {
			Spacer()
			Image(systemName: "checkmark.circle.fill")
				.font(.system(size: heroIconSize))
				.foregroundStyle(MaskinColor.doneFg)
				.accessibilityHidden(true)
			VStack(spacing: MaskinSpace.s3) {
				Text(model.successTitle).maskinText(.title).foregroundStyle(MaskinColor.ink)
				if let name = model.workspace?.name {
					Text(name).maskinText(.body).foregroundStyle(MaskinColor.ink4)
				}
			}
			.multilineTextAlignment(.center)
			Spacer()
			VStack(spacing: MaskinSpace.s5) {
				if let url = model.openURL {
					Button("Open in Maskin") { onOpen(url) }.buttonStyle(.primaryAction)
				}
				Button("Done", action: onClose).buttonStyle(.secondaryAction)
			}
			.padding(.horizontal, MaskinSpace.s10)
			.padding(.bottom, MaskinSpace.s9)
		}
		.accessibilityElement(children: .contain)
	}

	private var queued: some View {
		VStack(spacing: MaskinSpace.s11) {
			Spacer()
			Image(systemName: "clock.arrow.circlepath")
				.font(.system(size: heroIconSize))
				.foregroundStyle(MaskinColor.ink3)
				.accessibilityHidden(true)
			VStack(spacing: MaskinSpace.s3) {
				Text("Saved for later").maskinText(.title).foregroundStyle(MaskinColor.ink)
				Text(
					model.isNewChat
						? "Maskin will start the chat next time you open the app with a connection."
						: "Maskin will send it next time you open the app with a connection."
				)
					.maskinText(.body).foregroundStyle(MaskinColor.ink4)
			}
			.multilineTextAlignment(.center)
			.padding(.horizontal, MaskinSpace.s12)
			Spacer()
			Button("Done", action: onClose)
				.buttonStyle(.primaryAction)
				.padding(.horizontal, MaskinSpace.s10)
				.padding(.bottom, MaskinSpace.s9)
		}
	}

	private func blocked(_ error: ShareError) -> some View {
		VStack(spacing: MaskinSpace.s11) {
			Spacer()
			Image(systemName: error.needsApp ? "person.crop.circle.badge.exclamationmark" : "tray")
				.font(.system(size: blockedIconSize))
				.foregroundStyle(MaskinColor.ink4)
				.accessibilityHidden(true)
			Text(error.message)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink2)
				.multilineTextAlignment(.center)
				.padding(.horizontal, MaskinSpace.s12)
			if let detail = model.blockedDetail {
				Text(detail)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.multilineTextAlignment(.center)
					.padding(.horizontal, MaskinSpace.s12)
			}
			Spacer()
			VStack(spacing: MaskinSpace.s5) {
				if !model.copyableText.isEmpty {
					Button("Copy your text") { copyToPasteboard(model.copyableText) }
						.buttonStyle(.secondaryAction)
				}
				if error.needsApp, let url = URL(string: "maskin://open") {
					Button("Open Maskin") { onOpen(url) }.buttonStyle(.primaryAction)
				}
				Button("Close", action: onCancel).buttonStyle(.secondaryAction)
			}
			.padding(.horizontal, MaskinSpace.s10)
			.padding(.bottom, MaskinSpace.s9)
		}
	}
}

// MARK: - Preview card

/// What is being shared: kind label, a thumbnail for an image, the headline and one detail line.
struct SharePreviewCard: View {
	let content: ShareContent

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s8) {
			if let image = content.attachments.first(where: { $0.kind == .image }) {
				ShareThumbnail(url: image.fileURL).frame(width: 52, height: 52)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				MonoLabel(kindLabel)
				Text(headline)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(3)
				if let detail {
					Text(detail)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(3)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.accessibilityElement(children: .combine)
	}

	private var kindLabel: String {
		let files = content.attachments
		if files.count > 1 { return "\(files.count) FILES" }
		switch files.first?.kind {
		case .image?: return "IMAGE"
		case .pdf?: return "PDF"
		case .file?: return "FILE"
		case nil: return content.link != nil ? "LINK" : "TEXT"
		}
	}

	private var headline: String {
		let suggested = content.suggestedTitle
		return suggested.isEmpty ? "Shared item" : suggested
	}

	private var detail: String? {
		if let link = content.link {
			return content.linkTitle == nil ? nil : link.host ?? link.absoluteString
		}
		if let first = content.attachments.first {
			let size = ByteCountFormatter.string(fromByteCount: Int64(first.sizeBytes), countStyle: .file)
			return content.attachments.count > 1 ? first.name : "\(first.name) · \(size)"
		}
		if let text = content.text, text.contains("\n") || text.count > headline.count {
			return text
		}
		return nil
	}
}

/// A small, downsampled preview: ImageIO decodes straight to the thumbnail size.
struct ShareThumbnail: View {
	let url: URL
	@State private var image: CGImage?

	var body: some View {
		ZStack {
			MaskinSurface.cardInset2
			if let image {
				Image(decorative: image, scale: 2).resizable().scaledToFill()
			}
		}
		.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.cardLg, style: .continuous))
		.task(id: url) {
			image = await Task.detached(priority: .utility) { Self.thumbnail(url) }.value
		}
		.accessibilityHidden(true)
	}

	nonisolated static func thumbnail(_ url: URL) -> CGImage? {
		guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
		else { return nil }
		return CGImageSourceCreateThumbnailAtIndex(
			source, 0,
			[
				kCGImageSourceCreateThumbnailFromImageAlways: true,
				kCGImageSourceCreateThumbnailWithTransform: true,
				kCGImageSourceThumbnailMaxPixelSize: 160,
			] as CFDictionary)
	}
}
