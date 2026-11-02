import Foundation

/// The conversation as Markdown, for the thread menu's Export. Only what the messages hold:
/// author, time and text. Dividers (`system`) become italic lines; a message that failed to send
/// is left out because it never reached the chat.
public enum ChatExport {
	public static func markdown(
		title: String, messages: [ChatMessage], now: Date = .now, calendar: Calendar = .current
	) -> String {
		let sent = messages.filter {
			if case .failed = $0.status { return false }
			return !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		}
		var lines = ["# \(title.isEmpty ? "Chat" : title)", ""]
		var day: DateComponents?
		for message in sent {
			if let date = message.createdAt {
				let parts = calendar.dateComponents([.year, .month, .day], from: date)
				if parts != day {
					day = parts
					lines.append("## \(date.formatted(.dateTime.day().month(.wide).year().locale(Locale(identifier: "en_US"))))")
					lines.append("")
				}
			}
			if message.kind == "system" {
				lines.append("_\(message.content)_")
			} else {
				let time = message.createdAt.map {
					" (\($0.formatted(.dateTime.hour().minute().locale(Locale(identifier: "en_GB")))))"
				} ?? ""
				lines.append("**\(message.actorName)**\(time)")
				lines.append("")
				lines.append(message.content)
			}
			lines.append("")
		}
		return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
	}
}
