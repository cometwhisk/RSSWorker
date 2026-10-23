import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const weiboUtils = require('../src/lib/weibo/utils.js');
const createVisitorSession = weiboUtils.createVisitorSession;
const visitorUrl = 'https://visitor.passport.weibo.cn/visitor/genvisitor2';
const visitorResponse = (sub = 'guest-sub', subp = 'guest-subp') =>
	`visitor_gray_callback(${JSON.stringify({ retcode: 20000000, data: { sub, subp, tid: 'temporary-tid' } })});`;
const jsonResponse = (payload, ok = true) => ({
	ok,
	text: async () => payload,
	json: async () => payload,
});

test('mints and briefly caches a visitor cookie through genvisitor2', async () => {
	assert.equal(typeof createVisitorSession, 'function');
	let now = 0;
	const calls = [];
	const session = createVisitorSession({
		now: () => now,
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return jsonResponse(visitorResponse());
		},
	});

	assert.equal(await session.getCookie(), 'SUB=guest-sub; SUBP=guest-subp');
	assert.equal(await session.getCookie(), 'SUB=guest-sub; SUBP=guest-subp');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, visitorUrl);
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers.Cookie, undefined);
	assert.equal(calls[0].init.body, 'cb=visitor_gray_callback&tid=&from=weibo');

	now += 10 * 60 * 1000;
	assert.equal(await session.getCookie(), 'SUB=guest-sub; SUBP=guest-subp');
	assert.equal(calls.length, 2);
});

test('rejects visitor cookie values containing a double quote', async () => {
	const session = createVisitorSession({
		fetchImpl: async () => jsonResponse(visitorResponse('bad"sub', 'subp')),
	});

	await assert.rejects(session.getCookie(), (error) => error.message === 'Weibo visitor authentication failed');
});

test('coalesces concurrent visitor-cookie requests', async () => {
	assert.equal(typeof createVisitorSession, 'function');
	let calls = 0;
	const session = createVisitorSession({
		fetchImpl: async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return jsonResponse(visitorResponse());
		},
	});

	const cookies = await Promise.all([session.getCookie(), session.getCookie(), session.getCookie()]);
	assert.deepEqual(cookies, Array(3).fill('SUB=guest-sub; SUBP=guest-subp'));
	assert.equal(calls, 1);
});

test('uses the visitor cookie for Weibo API requests without a personal cookie', async () => {
	assert.equal(typeof createVisitorSession, 'function');
	const calls = [];
	const session = createVisitorSession({
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return url === visitorUrl ? jsonResponse(visitorResponse()) : jsonResponse({ ok: 1, data: { cards: [] } });
		},
	});

	const result = await session.requestJson('https://m.weibo.cn/api/test', {
		referer: 'https://m.weibo.cn/u/123',
	});

	assert.deepEqual(result, { ok: 1, data: { cards: [] } });
	assert.equal(calls.length, 2);
	assert.equal(calls[1].init.headers.Cookie, 'SUB=guest-sub; SUBP=guest-subp');
	assert.equal(calls[1].init.headers.Referer, 'https://m.weibo.cn/u/123');
});

test('refreshes one rejected visitor session and retries the API request once', async () => {
	assert.equal(typeof createVisitorSession, 'function');
	let visitorCount = 0;
	const apiCookies = [];
	const session = createVisitorSession({
		fetchImpl: async (url, init) => {
			if (url === visitorUrl) {
				visitorCount += 1;
				return jsonResponse(visitorResponse('sub-' + visitorCount, 'subp-' + visitorCount));
			}
			apiCookies.push(init.headers.Cookie);
			return apiCookies.length === 1 ? jsonResponse({ ok: -100 }) : jsonResponse({ ok: 1, data: { userInfo: {} } });
		},
	});

	const result = await session.requestJson('https://m.weibo.cn/api/test', { referer: 'https://m.weibo.cn/u/123' });
	assert.equal(result.ok, 1);
	assert.deepEqual(apiCookies, ['SUB=sub-1; SUBP=subp-1', 'SUB=sub-2; SUBP=subp-2']);
	assert.equal(visitorCount, 2);
});

test('does not discard a newer visitor session after a delayed old-session rejection', async () => {
	let visitorCount = 0;
	let releaseBothOldRequests;
	const bothOldRequestsStarted = new Promise((resolve) => {
		releaseBothOldRequests = resolve;
	});
	const oldRequestResolvers = [];
	const apiCookies = [];
	const session = createVisitorSession({
		fetchImpl: async (url, init) => {
			if (url === visitorUrl) {
				visitorCount += 1;
				return jsonResponse(visitorResponse('sub-' + visitorCount, 'subp-' + visitorCount));
			}
			const cookie = init.headers.Cookie;
			apiCookies.push(cookie);
			if (cookie === 'SUB=sub-1; SUBP=subp-1') {
				return new Promise((resolve) => {
					oldRequestResolvers.push(resolve);
					if (oldRequestResolvers.length === 2) releaseBothOldRequests();
				});
			}
			return jsonResponse({ ok: 1, data: { userInfo: {} } });
		},
	});

	const first = session.requestJson('https://m.weibo.cn/api/first', { referer: 'https://m.weibo.cn/u/123' });
	const second = session.requestJson('https://m.weibo.cn/api/second', { referer: 'https://m.weibo.cn/u/123' });
	await bothOldRequestsStarted;
	oldRequestResolvers[0](jsonResponse({ ok: -100 }));
	assert.equal((await first).ok, 1);
	oldRequestResolvers[1](jsonResponse({ ok: -100 }));
	assert.equal((await second).ok, 1);

	assert.equal(visitorCount, 2);
	assert.deepEqual(apiCookies, [
		'SUB=sub-1; SUBP=subp-1',
		'SUB=sub-1; SUBP=subp-1',
		'SUB=sub-2; SUBP=subp-2',
		'SUB=sub-2; SUBP=subp-2',
	]);
});

test('times out a stalled visitor mint and clears the pending mint', async () => {
	let visitorCount = 0;
	let apiRequestCount = 0;
	const session = createVisitorSession({
		timeoutMs: 20,
		fetchImpl: async (url, init) => {
			if (url === visitorUrl) {
				visitorCount += 1;
				if (visitorCount === 1) return { ok: true, text: async () => new Promise(() => {}) };
				return jsonResponse(visitorResponse('recovered-sub', 'recovered-subp'));
			}
			apiRequestCount += 1;
			return jsonResponse({ ok: 1, data: { cards: [] } });
		},
	});

	await assert.rejects(
		session.requestJson('https://m.weibo.cn/api/test', { referer: 'https://m.weibo.cn/u/123' }),
		(error) => error.message === 'Weibo API request failed',
	);
	assert.equal(apiRequestCount, 0);
	assert.equal(await session.getCookie(), 'SUB=recovered-sub; SUBP=recovered-subp');
	assert.equal(visitorCount, 2);
});

test('times out a stalled guest API response', async () => {
	let guestApiCount = 0;
	const session = createVisitorSession({
		timeoutMs: 20,
		fetchImpl: async (url, init) => {
			if (url === visitorUrl) return jsonResponse(visitorResponse());
			if (init.headers.Cookie === 'SUB=guest-sub; SUBP=guest-subp') {
				guestApiCount += 1;
				return { ok: true, json: async () => new Promise(() => {}) };
			}
			throw new Error('unexpected API request');
		},
	});

	await assert.rejects(
		session.requestJson('https://m.weibo.cn/api/test', { referer: 'https://m.weibo.cn/u/123' }),
		(error) => error.message === 'Weibo API request failed',
	);
	assert.equal(guestApiCount, 1);
});

test('returns a sanitized error when guest authentication is rejected', async () => {
	assert.equal(typeof createVisitorSession, 'function');
	const session = createVisitorSession({
		fetchImpl: async (url) => (url === visitorUrl ? jsonResponse(visitorResponse()) : jsonResponse({ ok: -100 })),
	});

	await assert.rejects(
		session.requestJson('https://m.weibo.cn/api/test', { referer: 'https://m.weibo.cn/u/123' }),
		(error) => error.message === 'Weibo API request failed' && !error.message.includes('guest-sub'),
	);
});

test('ignores WEIBO_COOKIE environment values when visitor authentication fails', async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		throw new Error('synthetic transport failure');
	};
	try {
		await assert.rejects(
			weiboUtils.fetchApiJson({ env: { WEIBO_COOKIE: 'legacy-account-cookie' } }, 'https://m.weibo.cn/api/test', 'https://m.weibo.cn/u/123'),
			(error) => error.message === 'Weibo API request failed',
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, visitorUrl);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
