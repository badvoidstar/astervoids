import { waitForPreview } from './target.mjs';

export default async function readiness(config) {
    if (Object.hasOwn(process.env, 'BROWSER_SMOKE_BASE_URL')) {
        await waitForPreview(config.projects[0].use.baseURL);
    }
}
