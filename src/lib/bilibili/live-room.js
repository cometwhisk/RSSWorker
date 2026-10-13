import { renderRss2 } from '../../utils/util';
import { escapeCdata, getLiveRoomData, InvalidRoomIdError, sanitizeXmlCharacters } from './live-room-data.mjs';

const deal = async (ctx) => {
	let feed;
	try {
		const roomID = ctx.req.param('roomID');
		const captureRaw412 = roomID === '510' && ctx.req.query('capture412') === '1';
		feed = await getLiveRoomData(roomID, globalThis.fetch, { captureRaw412 });
	} catch (error) {
		if (error instanceof InvalidRoomIdError) {
			return ctx.text('Invalid Bilibili live room ID', 400);
		}
		return ctx.text('Failed to fetch Bilibili live room', 502);
	}

	const title = `${feed.ownerName} 直播间开播状态`;
	const rss = renderRss2({
		title: escapeCdata(title),
		link: `https://live.bilibili.com/${feed.roomId}`,
		description: sanitizeXmlCharacters(title),
		language: 'zh-cn',
		items: feed.items,
	});
	ctx.header('Content-Type', 'application/xml');
	return ctx.body(rss);
};

const setup = (route) => {
	route.get('/bilibili/live/room/:roomID', deal);
};

export default { setup };
