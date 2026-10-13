import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mustache from 'mustache';

import { escapeCdata, getLiveRoomData, InvalidRoomIdError } from '../src/lib/bilibili/live-room-data.mjs';

const rssTemplate = readFileSync(new URL('../src/templates/rss2.txt', import.meta.url), 'utf8');

const jsonResponse = (payload, status = 200) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});

const createFetcher = ({ roomInit, roomInfo, anchorInfo, status = 200 }) => {
	const calls = [];
	const fetcher = async (input, options = {}) => {
		const url = new URL(input);
		calls.push({ url, options });
		if (url.pathname.endsWith('/room_init')) {
			return jsonResponse({ code: 0, data: roomInit }, status);
		}
		if (url.pathname.endsWith('/get_info')) {
			return jsonResponse({ code: 0, data: roomInfo }, status);
		}
		if (url.pathname.endsWith('/get_anchor_in_room')) {
			return jsonResponse({ code: 0, data: { info: anchorInfo } }, status);
		}
		return jsonResponse({ code: -404, message: 'unexpected endpoint' });
	};
	return { fetcher, calls };
};

test('sets opaque GUIDs non-permalink only when requested', () => {
	const render = (item) =>
		mustache.render(rssTemplate, {
			title: 'feed',
			link: 'https://example.test/feed',
			description: 'feed',
			items: [{ title: 'item', link: 'https://example.test/item', description: 'item', guid: 'opaque-id', ...item }],
		});

	assert.match(render({}), /<guid>opaque-id<\/guid>/);
	assert.match(render({ guidIsNotPermalink: true }), /<guid isPermaLink="false">opaque-id<\/guid>/);
});

test('rejects malformed room IDs before making an upstream request', async () => {
	let called = false;
	const fetcher = async () => {
		called = true;
		return jsonResponse({ code: 0, data: {} });
	};

	await assert.rejects(getLiveRoomData('../1', fetcher), InvalidRoomIdError);
	await assert.rejects(getLiveRoomData('0', fetcher), InvalidRoomIdError);
	assert.equal(called, false);
});

test('resolves a short room number and returns an empty feed while offline', async () => {
	const { fetcher, calls } = createFetcher({
		roomInit: { room_id: 123456 },
		roomInfo: { live_status: 0 },
		anchorInfo: { uname: '测试主播', face: 'https://i0.hdslb.com/avatar.jpg' },
	});

	const result = await getLiveRoomData('3', fetcher);

	assert.equal(result.roomId, '123456');
	assert.equal(result.ownerName, '测试主播');
	assert.deepEqual(result.items, []);
	assert.equal(calls.length, 3);
	assert.equal(calls[0].url.searchParams.get('id'), '3');
	assert.equal(calls[1].url.searchParams.get('roomid'), '123456');
	assert.equal(calls[2].url.searchParams.get('room_id'), '123456');
	assert.equal(calls[0].options.headers.Referer, 'https://live.bilibili.com/3');
	assert.equal(calls[1].options.headers.Referer, 'https://live.bilibili.com/123456');
	assert.equal(calls[2].options.headers.Referer, 'https://live.bilibili.com/123456');
});

test('creates a live item with a China-time timestamp and safe CDATA content', async () => {
	const { fetcher, calls } = createFetcher({
		roomInfo: {
			live_status: 1,
			title: '直播]]>标题',
			live_time: '2026-10-13 13:00:00',
			keyframe: 'https://i0.hdslb.com/cover.jpg?a=1&b=2',
			description: '介绍 &lt;em&gt;文本&lt;/em&gt; &amp; 更多]]>结束 &lt;img src=x onerror=alert(1)&gt;\u0001',
		},
		anchorInfo: { uname: '测试主播', face: 'https://i0.hdslb.com/avatar.jpg' },
	});

	const result = await getLiveRoomData('123456', fetcher);
	const [item] = result.items;

	assert.equal(result.roomId, '123456');
	assert.equal(result.ownerName, '测试主播');
	assert.equal(item.title, '直播]]]]><![CDATA[>标题 2026-10-13 13:00:00');
	assert.equal(item.link, 'https://live.bilibili.com/123456');
	assert.equal(item.guid, 'https://live.bilibili.com/123456 2026-10-13 13:00:00');
	assert.equal(item.guidIsNotPermalink, true);
	assert.equal(item.pubDate, new Date('2026-10-13T13:00:00+08:00').toUTCString());
	assert.match(item.description, /<img src="https:\/\/i0\.hdslb\.com\/cover\.jpg\?a=1&amp;b=2">/);
	assert.match(item.description, /介绍 &lt;em&gt;文本&lt;\/em&gt; &amp; 更多\]\]&gt;结束 &lt;img src=x onerror=alert\(1\)&gt;/);
	assert.doesNotMatch(item.description, /<img src=x onerror=/);
	assert.equal(item.description.includes('\u0001'), false);
	assert.equal(escapeCdata('a\u0001b]]>c'), 'ab]]]]><![CDATA[>c');
	assert.equal(calls.length, 2);
});

test('rejects non-success Bilibili API envelopes', async () => {
	const fetcher = async () => jsonResponse({ code: -400, message: 'invalid room' });
	await assert.rejects(getLiveRoomData('123456', fetcher), /Bilibili API request failed/);
});

test('logs a sanitized summary for an upstream 412 without exposing response text or room IDs', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	try {
		const fetcher = async () =>
			new Response(JSON.stringify({ code: -412, message: 'risk control blocked key=synthetic-secret' }), {
				status: 412,
				headers: { 'Content-Type': 'application/json; charset=utf-8' },
			});
		await assert.rejects(getLiveRoomData('3', fetcher), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}

	assert.equal(logEntries.length, 1);
	assert.equal(logEntries[0][0], '[bilibili] upstream_412');
	assert.deepEqual(logEntries[0][1], {
		endpoint: 'room_init',
		status: 412,
		contentTypeClass: 'json',
		apiCode: -412,
		bodyClass: 'risk_control',
	});
	const serialized = JSON.stringify(logEntries);
	assert.doesNotMatch(serialized, /synthetic-secret|risk control blocked|room_init\?id=3|live\.bilibili\.com/);
});

test('classifies a 412 HTML verification page without logging its body', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	try {
		const fetcher = async () =>
			new Response('<html>captcha verification required</html>', {
				status: 412,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		await assert.rejects(getLiveRoomData('3', fetcher), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}

	assert.equal(logEntries.length, 1);
	assert.deepEqual(logEntries[0][1], {
		endpoint: 'room_init',
		status: 412,
		contentTypeClass: 'html',
		apiCode: null,
		bodyClass: 'verification_challenge',
	});
	assert.doesNotMatch(JSON.stringify(logEntries), /captcha verification required|<html>/);
});

test('does not emit the temporary diagnostic for non-412 upstream failures', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	try {
		const fetcher = async () => new Response('blocked', { status: 403 });
		await assert.rejects(getLiveRoomData('3', fetcher), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(logEntries, []);
});

test('bounds logged 412 classification and tolerates cancellation rejection', async () => {
	const originalError = console.error;
	const logEntries = [];
	let cancelCalled = false;
	console.error = (...args) => logEntries.push(args);
	try {
		const body = `${'x'.repeat(2100)} risk control blocked`;
		const fetcher = async () => {
			const stream = new ReadableStream({
				start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
				cancel() {
					cancelCalled = true;
					return Promise.reject(new Error('synthetic cancel failure'));
				},
			});
			return new Response(stream, { status: 412, headers: { 'Content-Type': 'text/room-510-secret' } });
		};
		await assert.rejects(getLiveRoomData('3', fetcher), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}

	assert.equal(cancelCalled, true);
	assert.deepEqual(logEntries[0][1], {
		endpoint: 'room_init',
		status: 412,
		contentTypeClass: 'text',
		apiCode: null,
		bodyClass: 'unclassified',
	});
	assert.doesNotMatch(JSON.stringify(logEntries), /room-510-secret|risk control blocked|x{10}/);
});

test('returns the original error promptly when a 412 response body stalls', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	const fetcher = async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
		status: 412,
		headers: { 'Content-Type': 'text/plain' },
	});
	const startedAt = Date.now();
	try {
		await assert.rejects(getLiveRoomData('3', fetcher), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}
	assert.ok(Date.now() - startedAt < 1500, 'diagnostic must not wait indefinitely for the body');
	assert.equal(logEntries.length, 1);
	assert.equal(logEntries[0][1].bodyClass, 'empty');
});

test('keeps the route error unchanged when reading a 412 body rejects', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	try {
		const fetcher = async () => new Response(new ReadableStream({ pull() { throw new Error('synthetic stream failure'); } }), {
			status: 412,
			headers: { 'Content-Type': 'text/plain' },
		});
		await assert.rejects(getLiveRoomData('3', fetcher), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}
	assert.equal(logEntries.length, 1);
	assert.equal(logEntries[0][1].bodyClass, 'empty');
});

test('keeps the route error unchanged if console logging throws', async () => {
	const originalError = console.error;
	console.error = () => { throw new Error('synthetic logger failure'); };
	try {
		const fetcher = async () => new Response('verification required', { status: 412 });
		await assert.rejects(getLiveRoomData('3', fetcher), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}
});

test('uses only fixed endpoint labels for all Bilibili 412 diagnostics', async () => {
	for (const failedEndpoint of ['anchor_info', 'room_info']) {
		const originalError = console.error;
		const logEntries = [];
		console.error = (...args) => logEntries.push(args);
		try {
			const fetcher = async (input) => {
				const url = new URL(input);
				if (url.pathname.endsWith('/get_anchor_in_room')) {
					return failedEndpoint === 'anchor_info'
						? new Response('{"code":-412,"message":"blocked"}', { status: 412, headers: { 'Content-Type': 'application/json' } })
						: jsonResponse({ code: 0, data: { info: { uname: '测试主播' } } });
				}
				if (url.pathname.endsWith('/get_info')) {
					return failedEndpoint === 'room_info'
						? new Response('{"code":-412,"message":"blocked"}', { status: 412, headers: { 'Content-Type': 'application/json' } })
						: jsonResponse({ code: 0, data: { live_status: 0 } });
				}
				return jsonResponse({ code: -404, message: 'unexpected endpoint' });
			};
			await assert.rejects(getLiveRoomData('123456', fetcher), /Bilibili API request failed/);
		} finally {
			console.error = originalError;
		}
		assert.deepEqual(logEntries.map((entry) => entry[1].endpoint), [failedEndpoint]);
	}
});

test('rejects malformed room info instead of treating it as offline', async () => {
	for (const roomInfo of [{}, []]) {
		const { fetcher } = createFetcher({
			roomInfo,
			anchorInfo: { uname: '测试主播' },
		});
		await assert.rejects(getLiveRoomData('123456', fetcher), /Bilibili API request failed/);
	}
});

test('rejects invalid live timestamps instead of emitting an inaccurate pubDate', async () => {
	const { fetcher } = createFetcher({
		roomInfo: {
			live_status: 1,
			title: '直播标题',
			live_time: '2026-02-30 13:00:00',
		},
		anchorInfo: { uname: '测试主播' },
	});
	await assert.rejects(getLiveRoomData('123456', fetcher), /Bilibili API request failed/);
});

test('treats replay status as a valid non-live state', async () => {
	const { fetcher } = createFetcher({
		roomInfo: { live_status: 2 },
		anchorInfo: { uname: '测试主播' },
	});
	const result = await getLiveRoomData('123456', fetcher);
	assert.deepEqual(result.items, []);
});
