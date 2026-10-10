# RSSWorker

RSSWorker 是一个轻量级的 RSS 订阅工具，可以部署在 Cloudflare Worker 上。

## 支持

订阅路由直接挂在域名根路径下，例如 `https://rss.example.com/bilibili/user/dynamic/1`。订阅地址无需在路径中添加 `/rss`。

- bilibili 动态 (/bilibili/user/dynamic/:uid)
- bilibili 视频 (/bilibili/user/video/:uid)
- telegram 频道 (/telegram/channel/:username)
- weibo 用户 (/weibo/user/:uid)
- 小红书用户 (/xiaohongshu/user/:uid)

## 访问保护

内容请求只使用 URL 密钥认证，RSS 阅读器只需保存带密钥的链接。部署后，在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中添加名为 `RSS_ACCESS_KEY` 的 Secret。订阅链接需附加 `?key=<你的密钥>`，例如：

```text
https://rss.example.com/weibo/user/123456?key=<你的密钥>
```

无密钥或密钥错误时返回 403；`RSS_ACCESS_KEY` 未配置或为空时返回 503，不会退回其他认证方式。跨域 `OPTIONS` 预检由 CORS 中间件直接返回 204，不要求密钥，也不会返回订阅内容。`wrangler secret put RSS_ACCESS_KEY` 会设置已部署 Worker 的 Secret 并部署新版本；本地 `wrangler dev` 请在被 Git 忽略的 `.dev.vars` 文件中配置 `RSS_ACCESS_KEY`。请勿把实际值提交到 Git。

密钥就是链接本身的访问凭据：任何拿到完整链接的人都能访问订阅；链接可能留在阅读器历史或请求日志中，请不要公开或截图泄露。使用 HTTPS，并设置随机、独立、URL 安全的长密钥；如果密钥意外泄露，应更换 `RSS_ACCESS_KEY` 并更新订阅链接。

### 站点图标（可选）

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中添加普通 **Variable**（不是 Secret），变量名为 `RSS_SITE_ICON_URL`，值填写可公开访问的 HTTPS 图片直链。它用于 Worker HTML 页面的浏览器标签页图标（favicon），也供公开的 `/favicon.ico` 地址重定向到该图片；不会写入 RSS XML。只有这个静态图标入口不需要访问密钥，所有订阅数据地址仍必须提供正确的 `key`。本仓库启用 `keep_vars = true`，以便 Wrangler 自动部署时保留在 Cloudflare 面板中设置的变量。未设置或 URL 无效时不输出图标。本地开发可在被 Git 忽略的 `.dev.vars` 中设置同名变量。图标地址由运行环境提供，不写入源码。

> 小红书更新后不能再使用小红书号，需要使用小红书用户ID。  
> 获取方法：  
> 移动端：用户页面 > 右上角三个点 > 复制链接 > 获取链接中的用户ID  
> 网页端：用户页面 > 链接中的用户ID  
> 格式：https://www.xiaohongshu.com/user/profile/5d2aec020000000012037401

小红书订阅还需要在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中添加 Secret `XIAOHONGSHU_COOKIE`。请在已登录的小红书网页开发者工具的 Network 面板中，找到小红书主页请求并复制其 Request Headers 里的 `Cookie` 值，直接粘贴到 Cloudflare Secret；不要把 Cookie 发到聊天或提交到 Git。Cookie 是登录凭据，可能过期；过期后更新 Secret。未配置时该路由返回 503，Cookie 失效或主页仍被重定向时返回 502。若本地运行，`XIAOHONGSHU_COOKIE` 可放在被 Git 忽略的 `.dev.vars` 文件中。

> 微博更新后需要加上Cookie
> 获取方法（参考 https://docs.rsshub.app/zh/deploy/config#%E5%BE%AE%E5%8D%9A ） ：
> 1. 打开并登录微博
> 2. 从个人微博主页的网址中获取uid，在`https://m.weibo.cn/api/container/getIndex?type=uid&value=`后追加uid，访问该链接
> 2. 按下F12打开控制台，切换至Network（网络）面板
> 3. 在该网页切换至任意关注分组，并在面板打开最先捕获到的请求 （该情形下捕获到的请求路径应包含/feed/group）
> 4. 查看该请求的Headers（请求头）, 找到Cookie字段并复制内容
> 5. 命令行中输入`wrangler secret put WEIBO_COOKIE`，按下回车后再将第4步中复制的Cookie字段粘贴，后按下回车

## 部署

在 Cloudflare Dashboard 中进入 **Workers & Pages → Create application → Import a repository**，选择本仓库的 Fork 并部署。Worker 名称需与 `wrangler.toml` 中的 `name` 一致。部署后配置 `RSS_ACCESS_KEY` Secret，并将带 `?key=...` 的 Feed 地址添加到 RSS 阅读器。

## 开发

在 `src/lib/[网站名称]/[功能]` 参照已有的 demo 添加脚本，然后在 `src/route.js` 中添加插件即可。

注意事项：
1. Cloudflare Worker 有最大打包体积限制（免费用户 1 MB，付费用户 10 MB），所以插件需要尽量轻量化。如使用 fetch 进行请求、使用 Cloudflare Worker 提供的 HTMLRewriter 进行 HTML 解析等。

模板引擎使用的格式为：

```js
let items = [
	{
		title: 'Bilibili User Dynamic',
		link: `https://space.bilibili.com/${uid}/dynamic`,
		description: 'Bilibili User Dynamic233',
		pubDate: new Date().toUTCString(),
		guid: `https://space.bilibili.com/${uid}/dynamic`,
		author: 'bilibili@bilibili.com',
		category: 'video',
		comments: `https://space.bilibili.com/${uid}/dynamic`,
		enclosure: {
			url: 'https://www.bilibili.com/favicon.ico',
			type: 'image/x-icon',
			length: 0,
		},
		source: {
			title: 'Bilibili',
			url: 'https://www.bilibili.com',
		},
	},
];
let data = {
    title: `bilibili 动态`,
    link: `https://space.bilibili.com/${uid}/dynamic`,
    description: `${globalUsername} 的 bilibili 动态`,
    language: 'zh-cn',
    category: 'bilibili',
    items: items,
};
```

## 致谢

- [RSSHub](https://github.com/DIYgod/RSSHub) 灵感和部分代码来源

- [NodeSupport](https://github.com/NodeSeekDev/NodeSupport)赞助了本项目

[![image](https://img.imgdd.com/a3ae28fb-ec40-451b-9470-b14aa6dc034a.png)](https://yxvm.com/)
