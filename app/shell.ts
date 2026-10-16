import { packageContext } from '../src/lib/platform.ts'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function renderShell() {
	const appBase = String(packageContext?.appBasePath ?? '')
	const assetBase = String(packageContext?.assetBasePath ?? `${appBase}/_assets`)
	const clientUrl = `${assetBase}/client/main.js`
	const html = `<!doctype html>
<html lang="en" data-app-base="${esc(appBase)}" data-asset-base="${esc(assetBase)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0f1420" />
<title>World Builder · PowerSync + Neon on Cloudflare</title>
<link rel="icon" href="${esc(assetBase)}/icon.png" />
<link rel="manifest" href="${esc(appBase)}/manifest.webmanifest" />
<link rel="stylesheet" href="${esc(assetBase)}/styles.css" />
</head>
<body>
<div id="root"><div class="boot"><div class="boot-cube"></div></div></div>
<script type="module" src="${esc(clientUrl)}"></script>
</body>
</html>`
	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	})
}
