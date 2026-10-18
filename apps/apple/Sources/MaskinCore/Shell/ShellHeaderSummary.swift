import Foundation

/// The one functional sentence under a root screen's title: what needs the person right now.
/// Pure so the wording is tested without a view.
public enum ShellHeaderSummary {
	/// "SUN 18 OCT": the For you kicker. Other tabs use their own name.
	public static func dateKicker(_ date: Date, calendar: Calendar = .current, locale: Locale = .current)
		-> String
	{
		let formatter = DateFormatter()
		formatter.locale = locale
		formatter.calendar = calendar
		formatter.timeZone = calendar.timeZone
		formatter.setLocalizedDateFormatFromTemplate("EEEdMMM")
		return formatter.string(from: date).replacingOccurrences(of: ",", with: "").uppercased()
	}

	public static func forYou(decisionsWaiting: Int) -> String {
		decisionsWaiting > 0
			? "\(decisionsWaiting) \(decisionsWaiting == 1 ? "decision waits" : "decisions wait") on you."
			: "Nothing is blocked on you."
	}

	public static func chats(unreadConversations: Int) -> String {
		unreadConversations > 0
			? "\(unreadConversations) \(unreadConversations == 1 ? "conversation has" : "conversations have") unread messages."
			: "You\u{2019}re all caught up."
	}

	public static func flows(running: Int, needingYou: Int) -> String {
		if needingYou > 0 {
			return "\(needingYou) \(needingYou == 1 ? "flow is" : "flows are") waiting on you."
		}
		return running > 0 ? "Nothing is waiting on you." : "No flows are running."
	}

	public static func objects(needingYou: Int) -> String {
		needingYou > 0
			? "\(needingYou) \(needingYou == 1 ? "item needs" : "items need") you."
			: "Nothing needs you."
	}
}
