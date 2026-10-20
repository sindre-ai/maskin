import Testing

@testable import MaskinCore

@Suite("DictationAccumulator restarts without final")
struct DictationAccumulatorResetTests {
	@Test func keepsTextWhenTheRecogniserStartsOverMidTask() {
		var acc = DictationAccumulator()
		acc.update("remind me to call the dentist")
		acc.update("tomorrow")
		#expect(acc.text == "remind me to call the dentist tomorrow")
	}

	@Test func aRevisionOfTheTailIsNotAReset() {
		var acc = DictationAccumulator()
		acc.update("send the report to Sarah")
		acc.update("Send the report to Sara")
		#expect(acc.text == "Send the report to Sara")
	}

	@Test func aCapitalisedOrPunctuatedStartIsNotAReset() {
		var acc = DictationAccumulator()
		acc.update("hello there my friend")
		acc.update("Hello, there my friend")
		#expect(acc.text == "Hello, there my friend")
	}

	@Test func shortTextIsNeverTreatedAsAReset() {
		var acc = DictationAccumulator()
		acc.update("yes please")
		acc.update("no")
		#expect(acc.text == "no")
	}
}

@Suite("DictationDraft")
struct DictationDraftTests {
	@Test func appendsTheTranscriptToWhatWasTyped() {
		var draft = DictationDraft(base: "Note:")
		#expect(draft.apply(transcript: "buy milk", field: "Note:") == "Note: buy milk")
		#expect(draft.apply(transcript: "buy milk and eggs", field: "Note: buy milk") == "Note: buy milk and eggs")
	}

	@Test func keepsTextTypedWhileDictating() {
		var draft = DictationDraft(base: "")
		var field = draft.apply(transcript: "buy milk", field: "")
		field += " (organic)"
		field = draft.apply(transcript: "buy milk and eggs", field: field)
		#expect(field == "buy milk (organic) and eggs")
	}

	@Test func keepsTextTypedBeforeTheFirstWords() {
		var draft = DictationDraft(base: "")
		let field = draft.apply(transcript: "hello", field: "Hi. ")
		#expect(field == "Hi. hello")
	}

	@Test func survivesSeveralEdits() {
		var draft = DictationDraft(base: "")
		var field = draft.apply(transcript: "one", field: "")
		field += "!"
		field = draft.apply(transcript: "one two", field: field)
		field += "?"
		field = draft.apply(transcript: "one two three", field: field)
		#expect(field == "one! two? three")
	}

	@Test func aTranscriptThatStartsOverAfterAnEditIsAppendedWhole() {
		var draft = DictationDraft(base: "")
		var field = draft.apply(transcript: "alpha beta", field: "")
		field += "."
		field = draft.apply(transcript: "gamma", field: field)
		#expect(field == "alpha beta. gamma")
	}
}
