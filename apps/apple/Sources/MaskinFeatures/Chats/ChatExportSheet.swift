import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Header menu → Export chat (design 2d): Markdown as a file to share, and the chat's link.
/// PDF and audio-only exports are drawn in the design but need server support the app lacks, so
/// they are not offered.
struct ChatExportSheet: View {
	let title: String
	let messages: [ChatMessage]
	let participants: [ChatParticipant]
	let link: URL?
	@Environment(\.dismiss) private var dismiss
	@State private var copied = false

	var body: some View {
		NavigationStack {
			List {
				Section {
					ShareLink(
						item: ChatExport.markdown(title: title, messages: messages), subject: Text(title)
					) {
						row("doc.plaintext", "Markdown", "Messages, cards and transcripts")
					}
					if let link {
						Button {
							Clipboard.copy(link.absoluteString)
							MaskinHaptics.play(.success)
							copied = true
						} label: {
							row(copied ? "checkmark" : "link", copied ? "Copied" : "Copy link", "Members only")
						}
					}
				} footer: {
					Text(summary)
				}
			}
			.navigationTitle("Export chat")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
	}

	private func row(_ symbol: String, _ name: String, _ detail: String) -> some View {
		HStack(spacing: MaskinSpace.s7) {
			Image(systemName: symbol).foregroundStyle(MaskinColor.ink2)
				.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: 0) {
				Text(name).maskinText(.body).foregroundStyle(MaskinColor.ink)
				Text(detail).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	/// "38 messages from 3 people and 1 agent."
	private var summary: String {
		let said = messages.filter { $0.kind != "system" }
		let ids = Set(said.map(\.actorID))
		let people = participants.filter { ids.contains($0.id) && $0.kind != .agent }.count
		let agents = participants.filter { ids.contains($0.id) && $0.kind == .agent }.count
		func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }
		var who = [String]()
		if people > 0 { who.append(plural(people, "person", "people")) }
		if agents > 0 { who.append(plural(agents, "agent", "agents")) }
		return "\(plural(said.count, "message", "messages"))" + (who.isEmpty ? "." : " from \(who.joined(separator: " and ")).")
	}
}
