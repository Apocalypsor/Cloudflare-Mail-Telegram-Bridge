import { Hono } from 'hono';
import { PreviewPage } from '../../components/home';
import { formatBody } from '../../utils/format';
import type { AppEnv } from '../../types';
import { requireSession } from './middleware';
import { ROUTE_PREVIEW, ROUTE_PREVIEW_API } from './routes';

const preview = new Hono<AppEnv>();

preview.get(ROUTE_PREVIEW, requireSession(), (c) => {
	return c.html(<PreviewPage />);
});

preview.post(ROUTE_PREVIEW_API, requireSession(), async (c) => {
	const { html } = await c.req.json<{ html?: string }>();
	if (!html) return c.json({ result: '', length: 0 });
	const result = formatBody(undefined, html, 4000);
	return c.json({ result, length: result.length });
});

export default preview;
