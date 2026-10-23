# RSSWorker

轻量 RSS 订阅工具，部署在 Cloudflare Workers。

## 支持的路由

路由直接挂在域名根路径下，无需 `/rss` 前缀。

- Twitch 直播频道：`/twitch/live/:login`
- 微博用户：`/weibo/user/:uid`

## 访问保护

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中添加 `RSS_ACCESS_KEY` Secret，并在订阅链接后附加 `?key=<密钥>`。

```text
https://rss.example.com/weibo/user/123456?key=<密钥>
```

未配置密钥时返回 503，链接中的密钥缺失或错误时返回 403。请使用随机密钥，不要公开完整订阅链接或将密钥提交到 Git。

## 站点图标（可选）

将可公开访问的 HTTPS 图片地址设为普通 Variable `RSS_SITE_ICON_URL`。它用于网页标签页图标和公开的 `/favicon.ico`；RSS XML 不包含图标，订阅内容仍需密钥。

## 微博

微博订阅自动获取并短时缓存游客会话，不需要也不会读取个人登录 Cookie。

## 部署与开发

在 Cloudflare 中导入本仓库的 GitHub Fork 并部署。Worker 名称设为 `rss-worker`；推送到生产分支 `main` 后会自动部署。

本地开发使用被 Git 忽略的 `.dev.vars` 配置所需变量。首次运行先执行 `npm ci`，再用 `npm run dev` 调试、`node --test` 测试，`npm run build` 检查构建。

新增路由可参照 `src/lib/` 下的实现，并在 `src/route.js` 注册。RSS 内容通过 `renderRss2(data)` 渲染，数据结构可参考现有路由。

## 致谢

- [RSSHub](https://github.com/DIYgod/RSSHub)：灵感和部分代码来源
- [NodeSupport](https://github.com/NodeSeekDev/NodeSupport)：项目赞助

[![image](https://img.imgdd.com/a3ae28fb-ec40-451b-9470-b14aa6dc034a.png)](https://yxvm.com/)
