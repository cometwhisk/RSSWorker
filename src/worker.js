import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import indexHtml from './html/index.html';
import notFoundHtml from './html/404.html';
import errorHtml from './html/err.html';
import robotsTxt from './robots.txt';

import route from './route';

const app = new Hono();

app.use(
	'/*',
	cors({
		allowHeaders: ['Authorization'],
		allowMethods: ['GET', 'HEAD', 'OPTIONS'],
	})
);

// Require credentials from Cloudflare Worker secrets before serving any route.
// Basic Auth uses Hono's timing-safe credential comparison; missing secrets fail closed.
app.use('/*', async (ctx, next) => {
	const username = ctx.env?.RSS_AUTH_USERNAME;
	const password = ctx.env?.RSS_AUTH_PASSWORD;
	if (!username || !password) {
		return ctx.text('RSS authentication is not configured', 503);
	}
	return basicAuth({ username, password, realm: 'RSSWorker' })(ctx, next);
});

app.route('/rss', route);
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
	return ctx.html(notFoundHtml);
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
