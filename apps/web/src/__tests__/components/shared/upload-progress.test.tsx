import { UploadProgress } from '@/components/shared/upload-progress'
import { act, render, screen } from '@testing-library/react'

describe('UploadProgress', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('renders the success check when status is uploaded', () => {
		render(<UploadProgress progress={1} status="uploaded" />)
		expect(screen.getByLabelText('Uploaded')).toBeInTheDocument()
	})

	it('hides the success check after a few seconds', () => {
		render(<UploadProgress progress={1} status="uploaded" />)
		expect(screen.getByLabelText('Uploaded')).toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(4000)
		})

		expect(screen.queryByLabelText('Uploaded')).not.toBeInTheDocument()
	})

	it('renders the check when transitioning from uploading to uploaded', () => {
		const { rerender } = render(<UploadProgress progress={0.5} status="uploading" />)
		expect(screen.queryByLabelText('Uploaded')).not.toBeInTheDocument()

		rerender(<UploadProgress progress={1} status="uploaded" />)
		expect(screen.getByLabelText('Uploaded')).toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(4000)
		})

		expect(screen.queryByLabelText('Uploaded')).not.toBeInTheDocument()
	})

	it('renders error text when status is failed', () => {
		render(<UploadProgress progress={0} status="failed" error="Upload failed" />)
		expect(screen.getByText('Upload failed')).toBeInTheDocument()
	})
})
