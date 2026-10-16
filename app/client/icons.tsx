const s = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const PlaceIcon = () => (
	<svg {...s} aria-hidden="true"><path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z" /><path d="M12 12v9M3 7.5l9 4.5 9-4.5" /></svg>
)
export const RemoveIcon = () => (
	<svg {...s} aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /><path d="M10 11v6M14 11v6" /></svg>
)
export const BotIcon = () => (
	<svg {...s} width={16} height={16} aria-hidden="true"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01" /></svg>
)
export const PersonIcon = () => (
	<svg {...s} width={16} height={16} aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
)
export const PanelIcon = () => (
	<svg {...s} aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
)
export const SyncIcon = ({ state }: { state: 'synced' | 'syncing' | 'offline' }) => (
	<svg {...s} width={18} height={18} aria-hidden="true" className={`sync-icon ${state}`}>
		{state === 'offline' ? (
			<><path d="M2 2l20 20" /><path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M19 13a10 10 0 0 0-2.2-1.6M12 20h.01" /></>
		) : (
			<><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>
		)}
	</svg>
)
