export class InvalidRoomIdError extends Error {
	constructor() {
		super('Invalid Bilibili live room ID');
		this.name = 'InvalidRoomIdError';
	}
}

const normalizeRoomId = (value) => {
	const text = String(value ?? '');
	if (!/^\d+$/.test(text)) {
		throw new InvalidRoomIdError();
	}
	const numeric = Number(text);
	if (!Number.isSafeInteger(numeric) || numeric <= 0) {
		throw new InvalidRoomIdError();
	}
	return String(numeric);
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const getApiData = async (url, referer, fetchImpl) => {
	let response;
	try {
		response = await fetchImpl(url, {
			headers: { Referer: referer },
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		throw new Error('Bilibili API request failed');
	}
	if (!response?.ok) {
		throw new Error('Bilibili API request failed');
	}

	let payload;
	try {
		payload = await response.json();
	} catch {
		throw new Error('Bilibili API request failed');
	}
	if (!isObject(payload) || payload.code !== 0 || !isObject(payload.data)) {
		throw new Error('Bilibili API request failed');
	}
	return payload.data;
};

export const sanitizeXmlCharacters = (value) => {
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

const decodeCommonHtmlEntities = (value) =>
	String(value ?? '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
		if (entity[0] === '#') {
			const isHex = entity[1]?.toLowerCase() === 'x';
			const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
			if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
				return String.fromCodePoint(codePoint);
			}
			return match;
		}
		const named = {
			amp: '&',
			lt: '<',
			gt: '>',
			quot: '"',
			apos: "'",
			nbsp: '\u00a0',
		};
		return named[entity.toLowerCase()] ?? match;
	});

const escapeHtmlText = (value) =>
	sanitizeXmlCharacters(decodeCommonHtmlEntities(value)).replace(/[&<>]/g, (character) => {
		const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
		return escaped[character];
	});

const escapeHtmlAttribute = (value) =>
	sanitizeXmlCharacters(value).replace(/[&<>"']/g, (character) => {
		const escaped = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#39;',
		};
		return escaped[character];
	});

export const escapeCdata = (value) => sanitizeXmlCharacters(value).replace(/\]\]>/g, ']]]]><![CDATA[>');

const parseLiveTime = (value) => {
	if (typeof value !== 'string') {
		throw new Error('Bilibili API request failed');
	}
	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) {
		throw new Error('Bilibili API request failed');
	}
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
	if (
		year < 1970 || year > 9999 ||
		month < 1 || month > 12 || day < 1 || day > daysInMonth ||
		hour > 23 || minute > 59 || second > 59
	) {
		throw new Error('Bilibili API request failed');
	}
	const timestamp = Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		throw new Error('Bilibili API request failed');
	}
	return date.toUTCString();
};

const getLiveRoomId = async (shortId, fetchImpl) => {
	const url = new URL('https://api.live.bilibili.com/room/v1/Room/room_init');
	url.searchParams.set('id', shortId);
	const data = await getApiData(url, `https://live.bilibili.com/${shortId}`, fetchImpl);
	try {
		return normalizeRoomId(data.room_id);
	} catch {
		throw new Error('Bilibili API request failed');
	}
};

export const getLiveRoomData = async (inputRoomId, fetchImpl = globalThis.fetch) => {
	let roomId = normalizeRoomId(inputRoomId);
	if (typeof fetchImpl !== 'function') {
		throw new Error('Bilibili API request failed');
	}
	if (Number(roomId) < 10_000) {
		roomId = await getLiveRoomId(roomId, fetchImpl);
	}

	const roomUrl = `https://live.bilibili.com/${roomId}`;
	const anchorUrl = new URL('https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room');
	anchorUrl.searchParams.set('roomid', roomId);
	const roomInfoUrl = new URL('https://api.live.bilibili.com/room/v1/Room/get_info');
	roomInfoUrl.searchParams.set('room_id', roomId);
	roomInfoUrl.searchParams.set('from', 'room');

	const [anchorData, roomData] = await Promise.all([
		getApiData(anchorUrl, roomUrl, fetchImpl),
		getApiData(roomInfoUrl, roomUrl, fetchImpl),
	]);
	if (!isObject(anchorData.info) || typeof anchorData.info.uname !== 'string' || !anchorData.info.uname.trim()) {
		throw new Error('Bilibili API request failed');
	}
	if (![0, 1, 2].includes(roomData.live_status)) {
		throw new Error('Bilibili API request failed');
	}

	const ownerName = sanitizeXmlCharacters(anchorData.info.uname.trim());
	const items = [];
	if (roomData.live_status === 1) {
		const liveTime = typeof roomData.live_time === 'string' ? roomData.live_time.trim() : '';
		const pubDate = parseLiveTime(liveTime);
		const titleText = typeof roomData.title === 'string' ? roomData.title.trim() : '';
		const title = escapeCdata([titleText, liveTime].filter(Boolean).join(' '));
		let keyframe = '';
		if (typeof roomData.keyframe === 'string') {
			try {
				const imageUrl = new URL(roomData.keyframe);
				if (imageUrl.protocol === 'https:' && !imageUrl.username && !imageUrl.password) {
					keyframe = `<img src="${escapeHtmlAttribute(imageUrl.href)}"><br>`;
				}
			} catch {
				// Ignore malformed optional cover URLs.
			}
		}
		const descriptionText = escapeHtmlText(roomData.description);
		items.push({
			title,
			link: roomUrl,
			description: escapeCdata(`${keyframe}${descriptionText}`),
			pubDate,
			guid: `${roomUrl} ${liveTime}`,
			guidIsNotPermalink: true,
		});
	}

	return {
		roomId,
		ownerName,
		items,
	};
};
