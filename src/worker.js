import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { timingSafeEqual } from 'hono/utils/buffer';
import indexHtml from './html/index.html';
import notFoundHtml from './html/404.html';
import errorHtml from './html/err.html';
import robotsTxt from './robots.txt';

import route from './route';

const app = new Hono();

app.use(
	'/*',
	cors({
		allowMethods: ['GET', 'HEAD', 'OPTIONS'],
	})
);

// RSS readers authenticate with the query key; do not fall back to other auth modes.
app.use('/*', async (ctx, next) => {
	const accessKey = ctx.env?.RSS_ACCESS_KEY;
	if (typeof accessKey !== 'string' || accessKey.length === 0) {
		return ctx.text('RSS access key is not configured', 503);
	}
	const suppliedKey = ctx.req.query('key');
	if (!suppliedKey || !(await timingSafeEqual(accessKey, suppliedKey))) {
		return ctx.text('Missing or invalid access key', 403);
	}
	return next();
});

// Canonical feed URLs are mounted directly at the host root.
app.route('/', route);
app.get('/', (ctx) => {
	return ctx.html(indexHtml);
});
app.get('robots.txt', (ctx) => {
	return ctx.text(robotsTxt);
});
app.get('/debug', (ctx) => {
	return ctx.json(ctx.req.raw?.cf);
});
app.notFound((ctx) => {
	return ctx.html(notFoundHtml, 404);
});
app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return err.getResponse();
	}
	let stack_str = err.stack;
	let stack_arr = stack_str.split('\n').join('<br>');
	let result = errorHtml.replace('{ERROR_MESSAGE}', `${err}`);
	result = result.replace('{ERROR_STACK}', `${stack_arr}`);
	return c.html(result, 500);
});

export default app;
