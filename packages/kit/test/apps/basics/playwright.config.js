import process from 'node:process';
import { config, port as default_port } from '../../utils.js';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.KIT_E2E_PORT ?? default_port);

export default defineConfig({
	...config,
	use: {
		...config.use,
		channel:
			(process.env.KIT_E2E_BROWSER ?? 'chromium') === 'chromium' ? 'chromium' : config.use?.channel,
		baseURL: `http://localhost:${port}`,
		...(process.env.KIT_E2E_DEV_BYPASS_WAF
			? {
					storageState: {
						cookies: [
							{
								name: 'dev_bypass_waf',
								value: process.env.KIT_E2E_DEV_BYPASS_WAF,
								domain: 'localhost',
								path: '/',
								expires: -1,
								httpOnly: true,
								secure: false,
								sameSite: 'Lax'
							}
						],
						origins: []
					}
				}
			: {})
	},
	webServer: {
		command: process.env.DEV
			? `pnpm dev --port ${port} --strictPort`
			: `pnpm build && pnpm preview --port ${port} --strictPort`,
		port,
		timeout: 600_000,
		env: {
			PUBLIC_PRERENDERING: 'false',
			ROUTER_RESOLUTION: process.env.ROUTER_RESOLUTION ?? 'client'
		}
	}
});
