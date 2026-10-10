import atomTemplate from '../templates/atom.txt';
import rss2Template from '../templates/rss2.txt';

import mustache from 'mustache';

let renderAtom = (content) => {
	let renderedText = mustache.render(atomTemplate, content);
	return renderedText;
};

let renderRss2 = (content, env = {}) => {
	let siteIconUrl = '';
	const configuredIconUrl = typeof env?.RSS_SITE_ICON_URL === 'string' ? env.RSS_SITE_ICON_URL.trim() : '';
	if (configuredIconUrl) {
		try {
			const iconUrl = new URL(configuredIconUrl);
			if (iconUrl.protocol === 'https:') {
				siteIconUrl = iconUrl.href;
			}
		} catch {
			// Ignore an invalid optional icon URL rather than breaking the feed.
		}
	}
	let renderedText = mustache.render(rss2Template, { ...content, siteIconUrl });
	return renderedText;
};

export { renderAtom, renderRss2 };
