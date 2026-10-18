import Foundation
import Testing

@testable import MaskinCore

@Suite("ShellHeaderSummary")
struct ShellHeaderSummaryTests {
	@Test("For you counts decisions, singular and plural")
	func forYou() {
		#expect(ShellHeaderSummary.forYou(decisionsWaiting: 0) == "Nothing is blocked on you.")
		#expect(ShellHeaderSummary.forYou(decisionsWaiting: 1) == "1 decision waits on you.")
		#expect(ShellHeaderSummary.forYou(decisionsWaiting: 3) == "3 decisions wait on you.")
	}

	@Test("Chats counts unread conversations")
	func chats() {
		#expect(ShellHeaderSummary.chats(unreadConversations: 0) == "You\u{2019}re all caught up.")
		#expect(ShellHeaderSummary.chats(unreadConversations: 1) == "1 conversation has unread messages.")
		#expect(ShellHeaderSummary.chats(unreadConversations: 2) == "2 conversations have unread messages.")
	}

	@Test("Flows names how many wait on you, or that none run")
	func flows() {
		#expect(ShellHeaderSummary.flows(running: 4, needingYou: 1) == "1 flow is waiting on you.")
		#expect(ShellHeaderSummary.flows(running: 4, needingYou: 2) == "2 flows are waiting on you.")
		#expect(ShellHeaderSummary.flows(running: 4, needingYou: 0) == "Nothing is waiting on you.")
		#expect(ShellHeaderSummary.flows(running: 0, needingYou: 0) == "No flows are running.")
	}

	@Test("Objects counts what needs the person")
	func objects() {
		#expect(ShellHeaderSummary.objects(needingYou: 0) == "Nothing needs you.")
		#expect(ShellHeaderSummary.objects(needingYou: 1) == "1 item needs you.")
		#expect(ShellHeaderSummary.objects(needingYou: 5) == "5 items need you.")
	}

	@Test("The date kicker is upper-case weekday, day and month")
	func kicker() {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC")!
		let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 18, hour: 12))!
		#expect(
			ShellHeaderSummary.dateKicker(date, calendar: calendar, locale: Locale(identifier: "en_GB"))
				== "SUN 18 OCT")
	}
}
