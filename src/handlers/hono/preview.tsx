import { Hono } from 'hono';
import { PreviewPage } from '../../components/home';
import { convertPreview } from '../../services/home';
import type { Env } from '../../types';
import { requireSecret } from './middleware';
import { ROUTE_PREVIEW } from './routes';

const preview = new Hono<{ Bindings: Env }>();

preview.get(ROUTE_PREVIEW, requireSecret('GMAIL_WATCH_SECRET'), (c) => {
	return c.html(<PreviewPage secret={c.env.GMAIL_WATCH_SECRET} />);
});

preview.post(ROUTE_PREVIEW, requireSecret('GMAIL_WATCH_SECRET'), async (c) => {
	const { html } = await c.req.json<{ html?: string }>();
	if (!html) return c.json({ result: '', length: 0 });
	return c.json(convertPreview(html));
});

export default preview;
