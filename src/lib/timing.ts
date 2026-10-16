/**
 * Lightweight per-request profiling, reported as a `Server-Timing` header and a
 * one-line log. Records only durations and counts, never values. Module-level,
 * so overlapping requests in one isolate can blur numbers; fine for profiling.
 */
type Bucket = { ms: number; n: number }
let buckets: Record<string, Bucket> = {}
let started = 0

export function resetTiming() {
	buckets = {}
	started = performance.now()
}

export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now()
	try {
		return await fn()
	} finally {
		const b = (buckets[name] ??= { ms: 0, n: 0 })
		b.ms += performance.now() - t0
		b.n++
	}
}

export function serverTiming() {
	const parts = Object.entries(buckets).map(([k, b]) => `${k};dur=${b.ms.toFixed(0)};desc="${b.n}x"`)
	parts.push(`app;dur=${(performance.now() - started).toFixed(0)}`)
	return parts.join(', ')
}
