const XHS_ORIGIN = 'https://www.xiaohongshu.com';
const NOTE_ID_PATTERN = /^[0-9a-f]{24}$/i;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const noteImageCache = new Map();
const pendingRequests = new Map();

const toSafeImageUrl = (value) => {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const url = new URL(value.trim(), XHS_ORIGIN);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
		return url.href;
	} catch {
		return null;
	}
};

const decodeHrefAttribute = (value) => {
	if (typeof value !== 'string') return '';
	return value.replace(/&amp;|&#0*38;|&#x0*26;/gi, '&');
};

const extractNoteImageUrls = (imageList) => {
	if (!Array.isArray(imageList)) return [];
	const urls = [];
	for (const image of imageList) {
		const candidates = [
			typeof image === 'string' ? image : null,
			image?.urlDefault,
			image?.url,
			...(Array.isArray(image?.infoList) ? image.infoList.map((info) => info?.url) : []),
		];
		for (const candidate of candidates) {
			const url = toSafeImageUrl(candidate);
			if (url) {
				urls.push(url);
				break;
			}
		}
	}
	return [...new Set(urls)];
};

const parseInitialStateScript = (script) => {
	const prefix = 'window.__INITIAL_STATE__=';
	if (typeof script !== 'string' || !script.startsWith(prefix)) {
		throw new Error('Xiaohongshu page state was not found');
	}
	const source = script.slice(prefix.length);
	let json = '';
	let quote = '';
	let escaped = false;
	for (let index = 0; index < source.length; ) {
		const character = source[index];
		if (quote) {
			json += character;
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === quote) quote = '';
			index += 1;
			continue;
		}
		if (character === '"' || character === "'" || character === '`') {
			quote = character;
			json += character;
			index += 1;
			continue;
		}
		const previous = source[index - 1] || '';
		const nextAfterUndefined = source[index + 9] || '';
		if (
			!/[A-Za-z0-9_$]/.test(previous) &&
			source.startsWith('undefined', index) &&
			!/[A-Za-z0-9_$]/.test(nextAfterUndefined)
		) {
			json += 'null';
			index += 9;
			continue;
		}
		if (!/[A-Za-z0-9_$]/.test(previous)) {
			const emptyMap = source.slice(index).match(/^new\s+Map\s*\(\s*\[\s*\]\s*\)/);
			if (emptyMap) {
				json += 'null';
				index += emptyMap[0].length;
				continue;
			}
		}
		json += character;
		index += 1;
	}
	json = json.trim().replace(/;$/, '').trim();
	return JSON.parse(json);
};

const resolveNoteDetailUrl = (noteId, candidateUrl) => {
	if (typeof noteId !== 'string' || !NOTE_ID_PATTERN.test(noteId) || typeof candidateUrl !== 'string') return null;
	try {
		const sourceUrl = new URL(candidateUrl);
		const pathSegments = sourceUrl.pathname.split('/').filter(Boolean);
		const lastPathSegment = pathSegments.at(-1)?.toLowerCase();
		const validPath =
			(pathSegments.length === 2 && pathSegments[0] === 'explore' && NOTE_ID_PATTERN.test(pathSegments[1])) ||
			(pathSegments.length === 3 && pathSegments[0] === 'discovery' && pathSegments[1] === 'item' && NOTE_ID_PATTERN.test(pathSegments[2])) ||
			(pathSegments.length === 4 && pathSegments[0] === 'user' && pathSegments[1] === 'profile' && NOTE_ID_PATTERN.test(pathSegments[2]) && NOTE_ID_PATTERN.test(pathSegments[3]));
		if (
			sourceUrl.protocol !== 'https:' ||
			sourceUrl.origin !== XHS_ORIGIN ||
			sourceUrl.username ||
			sourceUrl.password ||
			!validPath ||
			lastPathSegment !== noteId.toLowerCase()
		) {
			return null;
		}
		const detailUrl = new URL(`/explore/${noteId}`, XHS_ORIGIN);
		for (const key of ['xsec_token', 'xsec_source']) {
			for (const value of sourceUrl.searchParams.getAll(key)) {
				if (value) detailUrl.searchParams.append(key, value);
			}
		}
		return detailUrl.href;
	} catch {
		return null;
	}
};

const getNoteFromState = (state, noteId) => {
	const rawNoteState = state?.note;
	const noteState = rawNoteState?._rawValue || rawNoteState;
	const rawNoteDetailMap = noteState?.noteDetailMap;
	const noteDetailMap = rawNoteDetailMap?._rawValue || rawNoteDetailMap;
	if (!noteDetailMap || typeof noteDetailMap !== 'object') return null;

	const firstNoteId = noteState.firstNoteId;
	const candidateKeys = [noteId];
	if (typeof firstNoteId === 'string' && firstNoteId.toLowerCase() === noteId.toLowerCase() && firstNoteId !== noteId) {
		candidateKeys.push(firstNoteId);
	}
	for (const key of candidateKeys) {
		const entry = noteDetailMap[key];
		const rawEntry = entry?._rawValue || entry;
		const rawNote = rawEntry?.note;
		const note = rawNote?._rawValue || rawNote || rawEntry;
		if (!note || typeof note !== 'object') continue;
		const identity = note.noteId || note.id;
		if (identity !== undefined && identity !== null && String(identity).toLowerCase() !== noteId.toLowerCase()) continue;
		return note;
	}
	return null;
};

const readCachedImages = (noteId, now) => {
	const cached = noteImageCache.get(noteId);
	if (!cached) return null;
	if (cached.expiresAt <= now()) {
		noteImageCache.delete(noteId);
		return null;
	}
	noteImageCache.delete(noteId);
	noteImageCache.set(noteId, cached);
	return [...cached.urls];
};

const writeCachedImages = (noteId, urls, now) => {
	if (!noteImageCache.has(noteId) && noteImageCache.size >= MAX_CACHE_ENTRIES) {
		const oldestNoteId = noteImageCache.keys().next().value;
		if (oldestNoteId !== undefined) noteImageCache.delete(oldestNoteId);
	}
	noteImageCache.set(noteId, { expiresAt: now() + CACHE_TTL_MS, urls: [...urls] });
};

const cancelResponseBody = async (response) => {
	if (!response?.body || response.body.locked) return;
	try {
		await response.body.cancel();
	} catch {
		// A body already consumed by the parser cannot be cancelled again.
	}
};

const getNoteImageUrls = async ({ noteId, noteUrl, cookie, fetchImpl = fetch, parseState, now = Date.now }) => {
	if (typeof noteId !== 'string' || !NOTE_ID_PATTERN.test(noteId) || typeof parseState !== 'function') return null;
	const detailUrl = resolveNoteDetailUrl(noteId, noteUrl);
	if (!detailUrl || typeof cookie !== 'string' || !cookie.trim()) return null;

	const cached = readCachedImages(noteId, now);
	if (cached !== null) return cached;
	const pending = pendingRequests.get(noteId);
	if (pending) {
		const pendingImages = await pending;
		return pendingImages === null ? null : [...pendingImages];
	}

	const request = (async () => {
		let response;
		try {
			response = await fetchImpl(detailUrl, {
				method: 'GET',
				redirect: 'manual',
				signal: AbortSignal.timeout(8000),
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
					Cookie: cookie.trim(),
				},
			});
			if (!response?.ok || (response.status >= 300 && response.status < 400)) {
				await cancelResponseBody(response);
				return null;
			}
			if (response.url) {
				const responseUrl = new URL(response.url);
				if (responseUrl.origin !== XHS_ORIGIN) {
					await cancelResponseBody(response);
					return null;
				}
			}
			const state = await parseState(response);
			const note = getNoteFromState(state, noteId);
			if (!note) return null;
			const imageList = note.imageList?._rawValue || note.imageList;
			const urls = extractNoteImageUrls(imageList);
			writeCachedImages(noteId, urls, now);
			return urls;
		} catch {
			await cancelResponseBody(response);
			return null;
		}
	})();

	pendingRequests.set(noteId, request);
	try {
		const urls = await request;
		return urls === null ? null : [...urls];
	} finally {
		if (pendingRequests.get(noteId) === request) pendingRequests.delete(noteId);
	}
};

const escapeHtml = (value) =>
	String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

const buildNoteImageHtml = (imageUrls, title) => {
	const safeUrls = (Array.isArray(imageUrls) ? imageUrls : []).map(toSafeImageUrl).filter(Boolean);
	const imageHtml = safeUrls.map((url) => `<img src="${escapeHtml(url)}">`).join('<br>');
	return `${imageHtml}${imageHtml ? '<br>' : ''}${escapeHtml(title)}`;
};

const clearNoteImageCache = () => {
	noteImageCache.clear();
	pendingRequests.clear();
};

module.exports = {
	buildNoteImageHtml,
	cancelResponseBody,
	clearNoteImageCache,
	decodeHrefAttribute,
	extractNoteImageUrls,
	getNoteImageUrls,
	parseInitialStateScript,
	resolveNoteDetailUrl,
};
