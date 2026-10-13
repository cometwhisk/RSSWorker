import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mustache from 'mustache';

import {
	getTwitchLiveData,
	InvalidTwitchLoginError,
	TwitchUserNotFoundError,
	escapeCdata,
} from '../src/lib/twitch/live-data.mjs';

const rssTemplate = readFileSync(new URL('../src/templates/rss2.txt', import.meta.url), 'utf8');

const makeBatch = ({
	userOrError = { __typename: 'User', id: '123', displayName: 'ExampleStreamer' },
	stream = null,
	lastBroadcast = { title: 'Previous stream' },
	tags = [],
	about = { description: 'Channel bio', profileImageURL: 'https://static-cdn.jtvnw.net/avatar.jpg' },
} = {}) => [
	{ data: { userOrError } },
	{ data: { user: { stream, lastBroadcast } } },
	{ data: { user: { stream: stream ? { freeformTags: tags } : null } } },
	{ data: { user: about } },
];

const createFetcher = (batch) => {
	const calls = [];
	const fetcher = async (url, options) => {
		calls.push({ url, options });
		return new Response(JSON.stringify(batch), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
	return { fetcher, calls };
};

test('rejects invalid Twitch logins before making a request', async () => {
	let called = false;
	const fetcher = async () => {
		called = true;
		throw new Error('should not call upstream');
	};
	for (const login of ['', '../streamer', 'name?x=1', 'a'.repeat(26)]) {
		await assert.rejects(getTwitchLiveData(login, fetcher), InvalidTwitchLoginError);
	}
	assert.equal(called, false);
});

test('sends the four persisted GraphQL operations in one bounded unauthenticated request', async () => {
	const { fetcher, calls } = createFetcher(makeBatch());
	await getTwitchLiveData('ExampleStreamer', fetcher);

	assert.equal(calls.length, 1);
	const { url, options } = calls[0];
	assert.equal(url, 'https://gql.twitch.tv/gql');
	assert.equal(options.method, 'POST');
	assert.equal(options.headers.Referer, 'https://player.twitch.tv');
	assert.equal(options.headers['Client-ID'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
	const operations = JSON.parse(options.body);
	assert.deepEqual(operations.map((operation) => operation.operationName), [
		'ChannelShell', 'StreamMetadata', 'RealtimeStreamTagList', 'ChannelRoot_AboutPanel',
	]);
	assert.deepEqual(operations.map((operation) => operation.extensions.persistedQuery.sha256Hash), [
		'fea4573a7bf2644f5b3f2cbbdcbee0d17312e48d2e55f080589d053aad353f11',
		'b57f9b910f8cd1a4659d894fe7550ccc81ec9052c01e438b290fd66a040b9b93',
		'a4747cac9d8e8bf6cf80969f6da6363ca1bdbd80fe136797e71504eb404313fd',
		'0df42c4d26990ec1216d0b815c92cc4a4a806e25b352b66ac1dd91d5a1d59b80',
	]);
	assert.deepEqual(operations.map((operation) => operation.variables), [
		{ login: 'examplestreamer', lcpVideosEnabled: false },
		{ channelLogin: 'examplestreamer', includeIsDJ: true },
		{ channelLogin: 'examplestreamer' },
		{ channelLogin: 'examplestreamer', skipSchedule: true, includeIsDJ: true },
	]);
	assert.ok(options.signal instanceof AbortSignal);
});

test('returns channel metadata and an empty item list while offline', async () => {
	const { fetcher } = createFetcher(makeBatch());
	const feed = await getTwitchLiveData('ExampleStreamer', fetcher);

	assert.equal(feed.title, 'Twitch - ExampleStreamer - Live');
	assert.equal(feed.link, 'https://www.twitch.tv/examplestreamer');
	assert.equal(feed.description, 'Channel bio');
	assert.equal(feed.image, 'https://static-cdn.jtvnw.net/avatar.jpg');
	assert.deepEqual(feed.items, []);
});

test('builds a live item with categories, stream ID, UTC date, and safe CDATA', async () => {
	const { fetcher } = createFetcher(makeBatch({
		stream: { id: 'stream-123', createdAt: '2026-10-13T05:15:00.000Z' },
		lastBroadcast: { title: 'Live ]]> title' },
		tags: [{ name: 'Just Chatting' }, { name: 'Games & Demos' }],
		about: {
			description: 'bio <script>alert(1)</script> & text',
			profileImageURL: 'https://static-cdn.jtvnw.net/avatar.jpg',
		},
	}));
	const feed = await getTwitchLiveData('ExampleStreamer', fetcher);
	const [item] = feed.items;

	assert.equal(item.title, 'Live ]]]]><![CDATA[> title');
	assert.equal(item.author, 'ExampleStreamer');
	assert.deepEqual(item.categories, ['Just Chatting', 'Games & Demos']);
	assert.equal(item.pubDate, new Date('2026-10-13T05:15:00.000Z').toUTCString());
	assert.equal(item.guid, 'stream-123');
	assert.equal(item.guidIsNotPermalink, true);
	assert.equal(item.link, 'https://www.twitch.tv/examplestreamer');
	assert.match(item.description, /live_user_examplestreamer\.jpg/);
	assert.doesNotMatch(item.description, /<script/i);

	const xml = mustache.render(rssTemplate, {
		...feed,
		title: escapeCdata(feed.title),
		items: feed.items,
	});
	assert.match(xml, /<image>/);
	assert.match(xml, /<url>https:&#x2F;&#x2F;static-cdn\.jtvnw\.net&#x2F;avatar\.jpg<\/url>/);
	assert.match(xml, /<category>Just Chatting<\/category>/);
	assert.match(xml, /<category>Games &amp; Demos<\/category>/);
	assert.ok(xml.includes('<title><![CDATA[Twitch - ExampleStreamer - Live]]></title>'));
	assert.ok(xml.includes('<title><![CDATA[Live ]]]]><![CDATA[> title]]></title>'));
	assert.match(xml, /<guid isPermaLink="false">stream-123<\/guid>/);
	assert.match(xml, /bio &lt;script&gt;alert\(1\)&lt;&#x2F;script&gt; &amp; text/);
});

test('falls back to ChannelShell metadata when the optional AboutPanel query errors', async () => {
	const batch = makeBatch({
		userOrError: {
			__typename: 'User',
			id: '123',
			displayName: 'ExampleStreamer',
			profileImageURL: 'https://static-cdn.jtvnw.net/channel-shell.jpg',
		},
		about: { description: '', profileImageURL: '' },
	});
	batch[3] = { data: { currentUser: null, user: null }, errors: [{ message: 'optional AboutPanel query failed' }] };
	const { fetcher } = createFetcher(batch);
	const feed = await getTwitchLiveData('examplestreamer', fetcher);

	assert.equal(feed.description, '');
	assert.equal(feed.image, 'https://static-cdn.jtvnw.net/channel-shell.jpg');
});

test('maps a missing Twitch user to a not-found result', async () => {
	const { fetcher } = createFetcher(makeBatch({
		userOrError: { __typename: 'UserNotFound' },
	}));
	await assert.rejects(getTwitchLiveData('missingchannel', fetcher), TwitchUserNotFoundError);
});

test('rejects malformed Twitch GraphQL responses and stream timestamps', async () => {
	const { fetcher: malformedFetcher } = createFetcher([{ data: null }]);
	await assert.rejects(getTwitchLiveData('examplestreamer', malformedFetcher), /Twitch API request failed/);

	const { fetcher: invalidDateFetcher } = createFetcher(makeBatch({
		stream: { id: 'stream-123', createdAt: '2026-02-30T05:15:00Z' },
	}));
	await assert.rejects(getTwitchLiveData('examplestreamer', invalidDateFetcher), /Twitch API request failed/);
});

test('omits malformed optional avatar URLs', async () => {
	const { fetcher } = createFetcher(makeBatch({
		about: { description: 'Channel bio', profileImageURL: 'javascript:alert(1)' },
	}));
	const feed = await getTwitchLiveData('examplestreamer', fetcher);
	assert.equal(feed.image, '');
});
