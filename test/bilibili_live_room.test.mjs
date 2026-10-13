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

test('captures at most 2 KiB of a 412 response only for the explicit short-room opt-in', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	try {
		const fetcher = async () => new Response(`<html>${'x'.repeat(5000)}</html>`, {
			status: 412,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
		await assert.rejects(getLiveRoomData('123456', fetcher, { captureRaw412: true }), /Bilibili API request failed/);
		await assert.rejects(getLiveRoomData('510', fetcher), /Bilibili API request failed/);
		assert.deepEqual(logEntries, []);
		await assert.rejects(getLiveRoomData('510', fetcher, { captureRaw412: true }), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}

	assert.equal(logEntries.length, 1);
	assert.equal(logEntries[0][0], '[bilibili] raw_412_sample');
	assert.deepEqual(Object.keys(logEntries[0][1]).sort(), ['bodyPrefix', 'contentTypeClass', 'endpoint', 'status']);
	assert.equal(logEntries[0][1].endpoint, 'room_init');
	assert.equal(logEntries[0][1].status, 412);
	assert.equal(logEntries[0][1].contentTypeClass, 'html');
	assert.ok(logEntries[0][1].bodyPrefix.startsWith('<html>'));
	assert.equal(new TextEncoder().encode(logEntries[0][1].bodyPrefix).byteLength, 2048);
	assert.doesNotMatch(JSON.stringify(logEntries), /live\.bilibili\.com|id=510|Referer|key=/i);
	assert.doesNotMatch(logEntries[0][1].bodyPrefix, /<\/html>/);
});

test('keeps the route error unchanged if raw 412 body reading stalls', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	const fetcher = async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
		status: 412,
		headers: { 'Content-Type': 'text/html' },
	});
	const startedAt = Date.now();
	try {
		await assert.rejects(getLiveRoomData('510', fetcher, { captureRaw412: true }), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}
	assert.ok(Date.now() - startedAt < 1500, 'raw capture must not wait indefinitely for the response body');
	assert.equal(logEntries.length, 1);
	assert.equal(logEntries[0][1].bodyPrefix, '');
});

test('does not capture non-412 failures even when raw capture is explicitly enabled', async () => {
	const originalError = console.error;
	const logEntries = [];
	console.error = (...args) => logEntries.push(args);
	try {
		const fetcher = async () => new Response('<html>denied</html>', { status: 403 });
		await assert.rejects(getLiveRoomData('510', fetcher, { captureRaw412: true }), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(logEntries, []);
});

test('keeps the route error unchanged if raw sample logging throws', async () => {
	const originalError = console.error;
	console.error = () => { throw new Error('synthetic logger failure'); };
	try {
		const fetcher = async () => new Response('<html>verification</html>', {
			status: 412,
			headers: { 'Content-Type': 'text/html' },
		});
		await assert.rejects(getLiveRoomData('510', fetcher, { captureRaw412: true }), /Bilibili API request failed/);
	} finally {
		console.error = originalError;
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
