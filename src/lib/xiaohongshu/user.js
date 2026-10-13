import { renderRss2 } from '../../utils/util';

let getUser = async (url, cookie) => {
	let res = await fetch(url, {
		redirect: 'manual', // Do not forward the session Cookie across redirects.
		headers: {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
			Cookie: cookie,
		}
	});
	if (!res.ok || (res.url && new URL(res.url).pathname.startsWith('/login'))) {
		throw new Error('Xiaohongshu did not return an authenticated profile page');
	}
	let scripts = [];
	const tokenizedPaths = new Map();
	let rewriter = new HTMLRewriter()
		.on('script', {
			element(element) {
				scripts.push('');
			},
			text(text) {
				scripts[scripts.length - 1] += text.text;
			},
		})
		.on('a[href*="xsec_token"]', {
			element(element) {
				const href = element.getAttribute('href');
				if (!href) return;
				const match = href.match(/\/([0-9a-f]{24})(?:\?|$)/i);
				if (!match || !href.includes('?')) return;
				try {
					const noteUrl = new URL(href, url);
					if (noteUrl.origin === 'https://www.xiaohongshu.com') {
						tokenizedPaths.set(match[1], noteUrl.href);
					}
				} catch {
					// Ignore malformed links from upstream page markup.
				}
			},
		})
		.transform(res);
	await rewriter.text();
	let script = scripts.find((script) => script.startsWith('window.__INITIAL_STATE__='));
	if (!script) {
		throw new Error('Xiaohongshu profile state was not found');
	}
	script = script.slice('window.__INITIAL_STATE__='.length);
	// replace undefined to null
	script = script.replace(/undefined/g, 'null');
	let state = JSON.parse(script);
	const user = state?.user;
	if (!user || typeof user !== 'object') {
		throw new Error('Xiaohongshu profile data was not found');
	}
	return {
		user: {
			...user,
			userPageData: user.userPageData?._rawValue || user.userPageData,
			notes: user.notes?._rawValue || user.notes,
		},
		tokenizedPaths,
	};
};

let deal = async (ctx) => {
	// const uid = ctx.params.user_id;
	// const category = ctx.params.category;
	const { uid } = ctx.req.param();
	const category = 'notes';
	const url = `https://www.xiaohongshu.com/user/profile/${uid}`;
	const cookie = ctx.env?.XIAOHONGSHU_COOKIE;
	if (typeof cookie !== 'string' || !cookie.trim()) {
		return ctx.text('XIAOHONGSHU_COOKIE is not configured', 503);
	}

	let user;
	let tokenizedPaths;
	try {
		({ user, tokenizedPaths } = await getUser(url, cookie.trim()));
	} catch {
		return ctx.text('小红书未返回用户资料。请检查 XIAOHONGSHU_COOKIE 是否有效，或稍后再试。', 502);
	}
	const userPageData = user.userPageData;
	const basicInfo = userPageData?.basicInfo;
	if (!basicInfo?.nickname || !Array.isArray(user.notes)) {
		return ctx.text('小红书未返回用户资料。请检查 Cookie 或主页访问权限。', 502);
	}
	const notes = user.notes;
	const tags = Array.isArray(userPageData.tags) ? userPageData.tags : [];
	const interactions = Array.isArray(userPageData.interactions) ? userPageData.interactions : [];

	const title = `${basicInfo.nickname} - ${category === 'notes' ? '笔记' : '收藏'} • 小红书 / RED`;
	const description = `${basicInfo.desc || ''} ${tags.map((t) => t?.name).filter(Boolean).join(' ')} ${interactions.map((i) => (i ? `${i.count} ${i.name}` : '')).filter(Boolean).join(' ')}`.trim();
	const image = basicInfo.imageb || basicInfo.images;

	const renderNote = (notes) =>
		notes
			.flatMap((group) => (Array.isArray(group) ? group : []))
			.map((entry) => {
				const noteCard = entry?.noteCard;
				if (!noteCard?.noteId) return null;
				const noteTitle = noteCard.displayTitle || noteCard.noteId;
				const coverList = Array.isArray(noteCard.cover?.infoList) ? noteCard.cover.infoList : [];
				const coverUrl = coverList.at(-1)?.url;
				const noteUrl = tokenizedPaths.get(entry.id) || tokenizedPaths.get(noteCard.noteId);
				return {
					title: noteTitle,
					link: noteUrl || `https://www.xiaohongshu.com/explore/${noteCard.noteId}`,
					guid: noteCard.noteId,
					description: `${coverUrl ? `<img src="${coverUrl}"><br>` : ''}${noteTitle}`,
					author: noteCard.user?.nickname || basicInfo.nickname,
					upvotes: noteCard.interactInfo?.likedCount,
				};
			})
			.filter(Boolean);
	const renderCollect = (collect) => {
		if (!collect) {
			throw Error('该用户已设置收藏内容不可见');
		}
		if (collect.code !== 0) {
			throw Error(JSON.stringify(collect));
		}
		if (!collect.data.notes.length) {
			throw ctx.throw(403, '该用户已设置收藏内容不可见');
		}
		return collect.data.notes.map((item) => ({
			title: item.display_title,
			link: `${url}/${item.note_id}`,
			description: `<img src ="${item.cover.info_list.pop().url}"><br>${item.display_title}`,
			author: item.user.nickname,
			upvotes: item.interact_info.likedCount,
		}));
	};

	ctx.header('Content-Type', 'application/xml');
	return ctx.body(
		renderRss2(
			{
				title,
				description,
				image,
				link: url,
				items: category === 'notes' ? renderNote(notes) : [],
			}
		)
	);
};

let setup = (route) => {
	route.get('/xiaohongshu/user/:uid', deal);
};

export default { setup };
