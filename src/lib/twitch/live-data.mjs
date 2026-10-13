export class InvalidTwitchLoginError extends Error {
	constructor() {
		super('Invalid Twitch login');
		this.name = 'InvalidTwitchLoginError';
	}
}

export class TwitchUserNotFoundError extends Error {
	constructor() {
		super('Twitch user not found');
		this.name = 'TwitchUserNotFoundError';
	}
}

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const persistedQuery = (operationName, sha256Hash, variables) => ({
	operationName,
	variables,
	extensions: { persistedQuery: { version: 1, sha256Hash } },
});

const createOperations = (login) => [
	persistedQuery('ChannelShell', 'fea4573a7bf2644f5b3f2cbbdcbee0d17312e48d2e55f080589d053aad353f11', {
		login,
		lcpVideosEnabled: false,
	}),
	persistedQuery('StreamMetadata', 'b57f9b910f8cd1a4659d894fe7550ccc81ec9052c01e438b290fd66a040b9b93', {
		channelLogin: login,
		includeIsDJ: true,
	}),
	persistedQuery('RealtimeStreamTagList', 'a4747cac9d8e8bf6cf80969f6da6363ca1bdbd80fe136797e71504eb404313fd', {
		channelLogin: login,
	}),
	persistedQuery('ChannelRoot_AboutPanel', '0df42c4d26990ec1216d0b815c92cc4a4a806e25b352b66ac1dd91d5a1d59b80', {
		channelLogin: login,
		skipSchedule: true,
		includeIsDJ: true,
	}),
];

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeLogin = (input) => {
	if (typeof input !== 'string') {
		throw new InvalidTwitchLoginError();
	}
	const login = input.trim();
	if (!/^[a-z\d_]{1,25}$/i.test(login)) {
		throw new InvalidTwitchLoginError();
	}
	return login.toLowerCase();
};

const sanitizeXmlCharacters = (value) => {
	let sanitized = '';
	for (const character of String(value ?? '')) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint === 0x09 ||
			codePoint === 0x0a ||
			codePoint === 0x0d ||
			(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
			(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
			(codePoint >= 0x10000 && codePoint <= 0x10ffff)
		) {
			sanitized += character;
		}
	}
	return sanitized;
};

export const escapeCdata = (value) => sanitizeXmlCharacters(value).replace(/\]\]>/g, ']]]]><![CDATA[>');

const parseTwitchDate = (value) => {
	if (typeof value !== 'string') {
		throw new Error('Twitch API request failed');
	}
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!match) {
		throw new Error('Twitch API request failed');
	}
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const millisecond = Number((fraction + '000').slice(0, 3));
	const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
	if (
		year < 1970 || year > 9999 ||
		month < 1 || month > 12 || day < 1 || day > daysInMonth ||
		hour > 23 || minute > 59 || second > 59
	) {
		throw new Error('Twitch API request failed');
	}

	let offsetMinutes = 0;
	if (zone !== 'Z') {
		const offset = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
		if (!offset) {
			throw new Error('Twitch API request failed');
		}
		const offsetHours = Number(offset[2]);
		const offsetRemainder = Number(offset[3]);
		if (offsetHours > 23 || offsetRemainder > 59) {
			throw new Error('Twitch API request failed');
		}
		offsetMinutes = (offsetHours * 60 + offsetRemainder) * (offset[1] === '+' ? 1 : -1);
	}

	const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMinutes * 60_000;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		throw new Error('Twitch API request failed');
	}
	return date.toUTCString();
};

const getBatchData = async (login, fetchImpl) => {
	let response;
	try {
		response = await fetchImpl(TWITCH_GQL_URL, {
			method: 'POST',
			headers: {
				'Client-ID': TWITCH_CLIENT_ID,
				'Content-Type': 'application/json',
				Referer: 'https://player.twitch.tv',
			},
			body: JSON.stringify(createOperations(login)),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		throw new Error('Twitch API request failed');
	}
	if (!response?.ok) {
		throw new Error('Twitch API request failed');
	}

	let payload;
	try {
		payload = await response.json();
	} catch {
		throw new Error('Twitch API request failed');
	}
	if (!Array.isArray(payload) || payload.length !== 4) {
		throw new Error('Twitch API request failed');
	}
	for (let index = 0; index < payload.length; index += 1) {
		const result = payload[index];
		if (
			!isRecord(result) ||
			!isRecord(result.data) ||
			(index < 3 && Array.isArray(result.errors) && result.errors.length > 0)
		) {
			throw new Error('Twitch API request failed');
		}
	}
	return payload.map((result) => result.data);
};

const getHttpsUrl = (value) => {
	if (typeof value !== 'string' || !value.trim()) {
		return '';
	}
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
	} catch {
		return '';
	}
};

export const getTwitchLiveData = async (inputLogin, fetchImpl = globalThis.fetch) => {
	const login = normalizeLogin(inputLogin);
	if (typeof fetchImpl !== 'function') {
		throw new Error('Twitch API request failed');
	}

	const [channelShellData, streamMetadataData, realtimeTagData, aboutPanelData] = await getBatchData(login, fetchImpl);
	const userOrError = channelShellData.userOrError;
	if (!isRecord(userOrError)) {
		throw new Error('Twitch API request failed');
	}
	if (userOrError.__typename === 'UserNotFound') {
		throw new TwitchUserNotFoundError();
	}
	if (typeof userOrError.id !== 'string' || !userOrError.id || typeof userOrError.displayName !== 'string' || !userOrError.displayName.trim()) {
		throw new Error('Twitch API request failed');
	}

	const streamUser = streamMetadataData.user;
	const aboutUser = isRecord(aboutPanelData.user) ? aboutPanelData.user : {};
	if (!isRecord(streamUser) || !Object.hasOwn(streamUser, 'stream')) {
		throw new Error('Twitch API request failed');
	}
	if (streamUser.stream !== null && !isRecord(streamUser.stream)) {
		throw new Error('Twitch API request failed');
	}

	const displayName = sanitizeXmlCharacters(userOrError.displayName.trim());
	const title = `Twitch - ${displayName} - Live`;
	const link = `https://www.twitch.tv/${login}`;
	const description = sanitizeXmlCharacters(typeof aboutUser.description === 'string' ? aboutUser.description : '');
	const image = getHttpsUrl(aboutUser.profileImageURL) || getHttpsUrl(userOrError.profileImageURL);
	const items = [];

	if (streamUser.stream) {
		const stream = streamUser.stream;
		const lastBroadcast = streamUser.lastBroadcast;
		if (
			typeof stream.id !== 'string' || !stream.id ||
			!isRecord(lastBroadcast) || typeof lastBroadcast.title !== 'string' ||
			!isRecord(realtimeTagData.user) || !isRecord(realtimeTagData.user.stream) ||
			!Array.isArray(realtimeTagData.user.stream.freeformTags)
		) {
			throw new Error('Twitch API request failed');
		}
		const categories = [...new Set(realtimeTagData.user.stream.freeformTags
			.filter((tag) => isRecord(tag) && typeof tag.name === 'string' && tag.name.trim())
			.map((tag) => sanitizeXmlCharacters(tag.name.trim())))];
		const previewUrl = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}.jpg`;
		items.push({
			title: escapeCdata(lastBroadcast.title),
			link,
			description: escapeCdata(`<img style="max-width: 100%;" src="${previewUrl}" />`),
			pubDate: parseTwitchDate(stream.createdAt),
			guid: sanitizeXmlCharacters(stream.id),
			guidIsNotPermalink: true,
			author: displayName,
			categories,
		});
	}

	return {
		login,
		title,
		link,
		description,
		image,
		items,
	};
};
