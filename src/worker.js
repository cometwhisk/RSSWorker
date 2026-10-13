import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { timingSafeEqual } from 'hono/utils/buffer';
import mustache from 'mustache';
import indexHtml from './html/index.html';
import notFoundHtml from './html/404.html';
import errorHtml from './html/err.html';
import robotsTxt from './robots.txt';
import { getSiteIconUrl } from './utils/util';

import route from './route';

const renderHtml = (template, env, data = {}) =>
	mustache.render(template, { ...data, siteIconUrl: getSiteIconUrl(env) });

const app = new Hono();

app.use(
	'/*',
	cors({
		allowMethods: ['GET', 'HEAD', 'OPTIONS'],
	})
);

app.use('/*', async (ctx, next) => {
	ctx.header('Referrer-Policy', 'no-referrer');
	await next();
});

// RSS readers authenticate with the query key; do not fall back to other auth modes.
app.use('/*', async (ctx, next) => {
	if (ctx.req.path === '/favicon.ico' && ['GET', 'HEAD'].includes(ctx.req.method)) {
		return next();
	}
	const accessKey = ctx.env?.RSS_ACCESS_KEY;
	if (typeof accessKey !== 'string' || accessKey.length === 0) {
		return ctx.text('RSS access key is not configured', 503);
	}
	const suppliedKey = ctx.req.query('key');
	if (!suppliedKey || !(await timingSafeEqual(accessKey, suppliedKey))) {
		if (['GET', 'HEAD'].includes(ctx.req.method)) {
			return ctx.html(renderHtml(indexHtml, ctx.env, { accessMessage: 'Missing or invalid access key' }), 403);
		}
		return ctx.text('Missing or invalid access key', 403);
	}
	return next();
});

// Canonical feed URLs are mounted directly at the host root.
app.route('/', route);
app.on(['GET', 'HEAD'], '/favicon.ico', (ctx) => {
	const iconUrl = getSiteIconUrl(ctx.env);
	if (!iconUrl) {
		return ctx.body(null, 404);
	}
	return ctx.redirect(iconUrl, 302);
});
app.get('/', (ctx) => {
	return ctx.html(renderHtml(indexHtml, ctx.env));
});
app.get('robots.txt', (ctx) => {
	return ctx.text(robotsTxt);
});
app.get('/debug', (ctx) => {
	return ctx.json(ctx.req.raw?.cf);
});
app.notFound((ctx) => {
	return ctx.html(renderHtml(notFoundHtml, ctx.env), 404);
});
app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return err.getResponse();
	}
	const result = renderHtml(errorHtml, c.env, {
		errorMessage: String(err),
		errorStack: String(err.stack ?? err),
	});
	return c.html(result, 500);
});

export default app;
