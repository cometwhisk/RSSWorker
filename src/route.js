import { Hono } from 'hono';
import twitch_live from './lib/twitch/live';
import weibo_user from './lib/weibo/user';

const route = new Hono();

let plugins = [twitch_live, weibo_user];

for (let plugin of plugins) {
	plugin.setup(route);
}

export default route;
