import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useDineroReviewLog(workspaceId: string, from: string, to: string) {
	return useQuery({
		queryKey: queryKeys.dineroReview.log(workspaceId, from, to),
		queryFn: () => api.dineroReview.log(workspaceId, from, to),
	})
}

export function useDineroVatReport(workspaceId: string, from: string, to: string) {
	return useQuery({
		queryKey: queryKeys.dineroReview.vatReport(workspaceId, from, to),
		queryFn: () => api.dineroReview.vatReport(workspaceId, from, to),
	})
}

export function useDineroVatCheckNote(workspaceId: string, from: string, to: string) {
	return useQuery({
		queryKey: queryKeys.dineroReview.vatCheckNote(workspaceId, from, to),
		queryFn: () => api.dineroReview.vatCheckNote(workspaceId, from, to),
	})
}

export function useDownloadDineroVatCsv(workspaceId: string) {
	return useMutation({
		mutationFn: async (p: { from: string; to: string }) => {
			const blob = await api.dineroReview.vatReportCsv(workspaceId, p.from, p.to)
			saveBlob(blob, `vat-report-draft-${p.from}-${p.to}.csv`)
		},
		onError: (err: Error) => toast.error(err.message),
	})
}

export function saveBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = filename
	document.body.appendChild(a)
	a.click()
	document.body.removeChild(a)
	URL.revokeObjectURL(url)
}

export function useReverseDineroItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (eventId: number) => api.dineroReview.reverse(workspaceId, eventId),
		onSuccess: (result) => {
			if (result.outcome === 'success') toast.success('Reversed in Dinero')
			else toast.error(result.message ?? 'Dinero did not accept the reversal')
			queryClient.invalidateQueries({ queryKey: queryKeys.dineroReview.all(workspaceId) })
		},
		onError: (err: Error) => toast.error(err.message),
	})
}

export function useApproveDineroBooks(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (body: { from: string; to: string; figures_hash: string }) =>
			api.dineroReview.approve(workspaceId, body),
		onSuccess: () => {
			toast.success('Books approved')
			queryClient.invalidateQueries({ queryKey: queryKeys.dineroReview.all(workspaceId) })
		},
		onError: (err: Error) => {
			toast.error(err.message)
			queryClient.invalidateQueries({ queryKey: queryKeys.dineroReview.all(workspaceId) })
		},
	})
}

export function useDineroFilingHandoff(workspaceId: string) {
	return useMutation({
		mutationFn: (body: { from: string; to: string }) =>
			api.dineroReview.filingHandoff(workspaceId, body),
		onError: (err: Error) => toast.error(err.message),
	})
}
