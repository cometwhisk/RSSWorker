import { Hono } from 'hono';
import bilibili_live_room from './lib/bilibili/live-room';
import twitch_live from './lib/twitch/live';
import weibo_user from './lib/weibo/user';
import xiaohongshu_user from './lib/xiaohongshu/user';

const route = new Hono();

let plugins = [bilibili_live_room, twitch_live, weibo_user, xiaohongshu_user];

for (let plugin of plugins) {
	plugin.setup(route);
}

export default route;
