import Foundation
import SwiftUI

extension EnvironmentValues {
	/// Whether this device can place a call. `MaskinUI` keeps clear of `UIApplication`, so the app
	/// root answers it. Where it is false (iPad without iPhone calling, Mac), tapping a number copies it.
	@Entry public var canPlaceCalls: Bool = true
	/// Shows a short confirmation ("Copied") the app root draws. Nil: the action still happens, quietly.
	@Entry public var showToast: (@MainActor (String) -> Void)? = nil
}

/// Phone numbers in prose and the `tel:` links they become. Detection is the system's own number
/// detector; the rules below only throw away what it is known to over-match (dates, ids, timestamps).
/// A number is personal data: nothing here logs it.
public enum PhoneNumberLink {
	/// A number with a country code (`+45 …`), or any number of 8 or more digits.
	private static let minDigitsWithCountryCode = 7
	private static let minDigits = 8
	/// E.164 allows 15 digits at most.
	private static let maxDigits = 15

	struct Match: Equatable {
		let range: NSRange
		let number: String
	}

	nonisolated(unsafe) private static let detector: NSDataDetector? = try? NSDataDetector(
		types: NSTextCheckingResult.CheckingType.phoneNumber.rawValue)

	/// `tel:+4512345678` for what a person wrote ("+45 12 34 56 78"); nil when it has no dialable digits.
	public static func url(for number: String) -> URL? {
		let dial = dialString(number)
		return isDialable(dial) ? URL(string: "tel:" + dial) : nil
	}

	/// The digits (and a leading `+`) of a `tel:` link, for copying where nothing can call.
	public static func dialString(of url: URL) -> String {
		dialString(String(url.absoluteString.dropFirst("tel:".count)))
	}

	/// Digits with an optional leading `+`; spaces, dashes and brackets dropped.
	static func dialString(_ number: String) -> String {
		var out = ""
		for ch in number.trimmingCharacters(in: .whitespacesAndNewlines) {
			if ch == "+", out.isEmpty {
				out.append(ch)
			} else if ch.isASCII, ch.isNumber {
				out.append(ch)
			}
		}
		return out
	}

	/// Only a number that is plain digits (and a leading `+`) may ride on a `tel:` link; this is what the
	/// link policy checks, so a `tel:*21*…#` code or a bare `tel:` never opens.
	static func isDialable(_ dial: String) -> Bool {
		let digits = dial.filter(\.isNumber).count
		return (1...maxDigits).contains(digits) && dial.allSatisfy { $0.isNumber || $0 == "+" }
			&& !dial.dropFirst().contains("+")
	}

	/// Whether `text` holds seven or more digits in one stretch that only digits and phone separators
	/// ("+ - . ( )" and spaces) interrupt. Anything shorter is never a number worth the detector.
	static func hasPhoneSizedDigitRun(_ text: String) -> Bool {
		var digits = 0
		for ch in text.unicodeScalars {
			if ch.properties.numericType != nil {
				digits += 1
				if digits >= 7 { return true }
			} else if !"+-.() \u{00A0}".unicodeScalars.contains(ch) {
				digits = 0
			}
		}
		return false
	}

	/// The phone numbers in `text`, in order.
	static func matches(in text: String) -> [Match] {
		// Most text has no digits at all; skip the detector for it.
		guard hasPhoneSizedDigitRun(text), let detector else { return [] }
		let whole = NSRange(text.startIndex..., in: text)
		var found: [Match] = []
		detector.enumerateMatches(in: text, options: [], range: whole) { result, _, _ in
			guard let result, result.resultType == .phoneNumber, let range = Range(result.range, in: text) else { return }
			let number = String(text[range])
			let after = text[range.upperBound...]
			if isPhoneNumber(
				number, before: text[..<range.lowerBound].last, after: after.first, afterNext: after.dropFirst().first)
			{
				found.append(Match(range: result.range, number: number))
			}
		}
		return found
	}

	/// Whether `number`, with the characters around it, reads as a phone number.
	static func isPhoneNumber(_ number: String, before: Character?, after: Character?, afterNext: Character?) -> Bool {
		let digits = number.filter { $0.isASCII && $0.isNumber }.count
		let hasCountryCode = number.hasPrefix("+")
		guard digits <= maxDigits, digits >= (hasCountryCode ? minDigitsWithCountryCode : minDigits) else { return false }
		// Part of a longer word, path, address or id ("a1b2-12345678-c3", "/12345678", "x@12345678").
		if let before, before.isLetter || before.isNumber || "_-/@#.".contains(before) { return false }
		if let after {
			if after.isLetter || after.isNumber || "_/@".contains(after) { return false }
			if "-.".contains(after), let afterNext, afterNext.isLetter || afterNext.isNumber { return false }
		}
		let bare = number.trimmingCharacters(in: .whitespaces)
		// 2026-11-04, 04.11.2026, 04/11/26: dates.
		if bare.range(of: #"^\d{4}-\d{2}-\d{2}"#, options: .regularExpression) != nil
			|| bare.range(of: #"^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$"#, options: .regularExpression) != nil
		{
			return false
		}
		// Ten unbroken digits starting with 1 are a Unix timestamp; twelve or more unbroken digits (a
		// millisecond timestamp, an id) are not a number someone wrote without a + or breaks.
		if !hasCountryCode, bare.allSatisfy({ $0.isASCII && $0.isNumber }) {
			if bare.count > 11 { return false }
			if bare.hasPrefix("1"), bare.count == 10 { return false }
		}
		return true
	}
}
