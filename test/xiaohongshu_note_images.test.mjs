import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	buildNoteImageHtml,
	cancelResponseBody,
	clearNoteImageCache,
	decodeHrefAttribute,
	extractNoteImageUrls,
	getNoteImageUrls,
	parseInitialStateScript,
	resolveNoteDetailUrl,
} = require('../src/lib/xiaohongshu/note_images.js');

const noteId = '0123456789abcdef01234567';
const userId = 'abcdefabcdefabcdefabcdef';
const noteUrl = `https://www.xiaohongshu.com/user/profile/${userId}/${noteId}?xsec_token=fixture-token&xsec_source=pc_feed&redirect=https%3A%2F%2Fevil.example`;
const detailUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fixture-token&xsec_source=pc_feed`;

test('extractNoteImageUrls returns distinct HTTPS image URLs in source order', () => {
	assert.deepEqual(
		extractNoteImageUrls([
			{ urlDefault: 'https://cdn.example/a.jpg' },
			{ urlDefault: 'https://cdn.example/a.jpg' },
			{ urlDefault: 'https://cdn.example/b.jpg' },
			{ infoList: [{ url: 'https://cdn.example/c.jpg' }] },
			{ urlDefault: 'http://cdn.example/insecure.jpg' },
			{ urlDefault: 'javascript:alert(1)' },
		]),
		['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg', 'https://cdn.example/c.jpg']
	);
});

test('resolveNoteDetailUrl reconstructs a safe explore path with only XHS tokens', () => {
	assert.equal(resolveNoteDetailUrl(noteId, noteUrl), detailUrl);
	assert.equal(resolveNoteDetailUrl(noteId, `https://attacker.example/explore/${noteId}?xsec_token=x`), null);
	assert.equal(resolveNoteDetailUrl(noteId, `https://www.xiaohongshu.com/explore/${noteId.slice(0, -1)}0?xsec_token=x`), null);
	assert.equal(resolveNoteDetailUrl(noteId, `https://www.xiaohongshu.com/user/profile/${userId}?xsec_token=x`), null);
});

test('decodeHrefAttribute recovers escaped XHS query separators before URL parsing', () => {
	const encodedHref = noteUrl.replaceAll('&', '&amp;');
	assert.equal(decodeHrefAttribute(encodedHref), noteUrl);
	assert.equal(decodeHrefAttribute(noteUrl.replaceAll('&', '&#38;')), noteUrl);
	assert.equal(decodeHrefAttribute('https://www.xiaohongshu.com/?x=1&amp;#38;y=2'), 'https://www.xiaohongshu.com/?x=1&#38;y=2');
	assert.equal(resolveNoteDetailUrl(noteId, decodeHrefAttribute(encodedHref)), detailUrl);
	assert.equal(decodeHrefAttribute(''), '');
});

test('parseInitialStateScript normalizes literals outside strings only', () => {
	const state = parseInitialStateScript(
		'window.__INITIAL_STATE__={"text":"undefined and new Map([])","imageUrl":"https://cdn.example/undefined.jpg","missing":undefined,"emptyMap":new Map ( [ ] )};'
	);

	assert.deepEqual(state, {
		text: 'undefined and new Map([])',
		imageUrl: 'https://cdn.example/undefined.jpg',
		missing: null,
		emptyMap: null,
	});
	assert.deepEqual(extractNoteImageUrls([{ urlDefault: state.imageUrl }]), ['https://cdn.example/undefined.jpg']);
});

test('buildNoteImageHtml renders every image and escapes HTML values', () => {
	const html = buildNoteImageHtml(
		['https://cdn.example/a.jpg?x=1&y=2', 'https://cdn.example/b.jpg'],
		'<title & description>'
	);

	assert.equal((html.match(/<img\b/g) || []).length, 2);
	assert.match(html, /a\.jpg\?x=1&amp;y=2/);
	assert.match(html, /&lt;title &amp; description&gt;/);
});

test('getNoteImageUrls uses the fixed XHS host, Cookie, and manual redirects', async () => {
	clearNoteImageCache();
	let request;
	const wrappedState = {
		note: {
			_rawValue: {
				firstNoteId: noteId,
				noteDetailMap: {
					_rawValue: {
						[noteId]: {
							_rawValue: {
								note: {
									_rawValue: {
										noteId,
										imageList: {
											_rawValue: [
												{ urlDefault: 'https://cdn.example/one.jpg' },
												{ urlDefault: 'https://cdn.example/two.jpg' },
											],
										},
									},
								},
							},
						},
					},
				},
			},
		},
	};
	const urls = await getNoteImageUrls({
		noteId,
		noteUrl,
		cookie: 'fixture-cookie',
		fetchImpl: async (url, init) => {
			request = { url: String(url), init };
			return new Response('fixture', { status: 200 });
		},
		parseState: async () => wrappedState,
		now: () => 1000,
	});

	assert.deepEqual(urls, ['https://cdn.example/one.jpg', 'https://cdn.example/two.jpg']);
	assert.equal(request.url, detailUrl);
	assert.equal(request.init.redirect, 'manual');
	assert.equal(request.init.headers.Cookie, 'fixture-cookie');
});

test('getNoteImageUrls rejects unsafe URLs before sending the Cookie', async () => {
	clearNoteImageCache();
	let fetchCount = 0;
	const urls = await getNoteImageUrls({
		noteId,
		noteUrl: `https://attacker.example/explore/${noteId}?xsec_token=x`,
		cookie: 'fixture-cookie',
		fetchImpl: async () => {
			fetchCount += 1;
			return new Response('unexpected');
		},
		parseState: async () => ({}),
	});

	assert.equal(urls, null);
	assert.equal(fetchCount, 0);
});

test('getNoteImageUrls rejects unrelated firstNoteId fallback data', async () => {
	clearNoteImageCache();
	const otherNoteId = 'fedcba9876543210fedcba98';
	let fetchCount = 0;
	const unrelatedStates = [
		{
			note: {
				firstNoteId: otherNoteId,
				noteDetailMap: {
					[otherNoteId]: {
						note: { imageList: [{ urlDefault: 'https://cdn.example/unrelated.jpg' }] },
					},
				},
			},
		},
		{
			note: {
				firstNoteId: otherNoteId,
				noteDetailMap: {
					[noteId]: {
						note: { noteId: otherNoteId, imageList: [{ urlDefault: 'https://cdn.example/unrelated.jpg' }] },
					},
				},
			},
		},
	];

	for (const state of unrelatedStates) {
		const urls = await getNoteImageUrls({
			noteId,
			noteUrl: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fixture-token`,
			cookie: 'fixture-cookie',
			fetchImpl: async () => {
				fetchCount += 1;
				return new Response('fixture', { status: 200 });
			},
			parseState: async () => state,
		});
		assert.equal(urls, null);
	}

	assert.equal(fetchCount, 2);
});

test('cancelResponseBody cancels only an unlocked response body', async () => {
	let cancelCount = 0;
	await cancelResponseBody({ body: { locked: false, cancel: async () => { cancelCount += 1; } } });
	await cancelResponseBody({ body: { locked: true, cancel: async () => { cancelCount += 1; } } });
	await cancelResponseBody(null);
	assert.equal(cancelCount, 1);
});

test('getNoteImageUrls rejects redirects without parsing the response', async () => {
	clearNoteImageCache();
	let parseCount = 0;
	let cancelCount = 0;
	const urls = await getNoteImageUrls({
		noteId,
		noteUrl,
		cookie: 'fixture-cookie',
		fetchImpl: async () => ({
			ok: false,
			status: 302,
			body: {
				locked: false,
				cancel: async () => {
					cancelCount += 1;
				},
			},
		}),
		parseState: async () => {
			parseCount += 1;
			return {};
		},
	});

	assert.equal(urls, null);
	assert.equal(parseCount, 0);
	assert.equal(cancelCount, 1);
});

test('getNoteImageUrls reuses successful note image cache entries', async () => {
	clearNoteImageCache();
	let fetchCount = 0;
	const options = {
		noteId,
		noteUrl,
		cookie: 'fixture-cookie',
		fetchImpl: async () => {
			fetchCount += 1;
			return new Response('fixture', { status: 200 });
		},
		parseState: async () => ({
			note: {
				firstNoteId: noteId,
				noteDetailMap: {
					[noteId]: { note: { noteId, imageList: [{ urlDefault: 'https://cdn.example/cached.jpg' }] } },
				},
			},
		}),
		now: () => 1000,
	};

	const first = await getNoteImageUrls(options);
	const second = await getNoteImageUrls(options);

	assert.deepEqual(first, ['https://cdn.example/cached.jpg']);
	assert.deepEqual(second, first);
	assert.equal(fetchCount, 1);
});
