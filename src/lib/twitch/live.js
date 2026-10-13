import { renderRss2 } from '../../utils/util';
import { escapeCdata, getTwitchLiveData, InvalidTwitchLoginError, TwitchUserNotFoundError } from './live-data.mjs';

const deal = async (ctx) => {
	let feed;
	try {
		feed = await getTwitchLiveData(ctx.req.param('login'));
	} catch (error) {
		if (error instanceof InvalidTwitchLoginError) {
			return ctx.text('Invalid Twitch login', 400);
		}
		if (error instanceof TwitchUserNotFoundError) {
			return ctx.text('Twitch channel not found', 404);
		}
		return ctx.text('Failed to fetch Twitch live channel', 502);
	}

	const rss = renderRss2({
		title: escapeCdata(feed.title),
		link: feed.link,
		description: feed.description,
		image: feed.image,
		items: feed.items,
	});
	ctx.header('Content-Type', 'application/xml');
	return ctx.body(rss);
};

const setup = (route) => {
	route.get('/twitch/live/:login', deal);
};

export default { setup };
