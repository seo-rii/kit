import process from 'node:process';
import { config } from '../../utils.js';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.KIT_E2E_PORT ?? (process.env.DEV ? 5173 : 4173));

export default defineConfig({
	...config,
	webServer: {
		command: process.env.DEV
			? `pnpm dev --port ${port}`
			: `pnpm build && pnpm preview --port ${port}`,
		port,
		env: {
			PUBLIC_PRERENDERING: 'false',
			ROUTER_RESOLUTION: process.env.ROUTER_RESOLUTION ?? 'client'
		}
	}
});
