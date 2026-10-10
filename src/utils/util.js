import atomTemplate from '../templates/atom.txt';
import rss2Template from '../templates/rss2.txt';

import mustache from 'mustache';

let renderAtom = (content) => {
	let renderedText = mustache.render(atomTemplate, content);
	return renderedText;
};

const getSiteIconUrl = (env = {}) => {
	const configuredIconUrl = typeof env?.RSS_SITE_ICON_URL === 'string' ? env.RSS_SITE_ICON_URL.trim() : '';
	if (configuredIconUrl) {
		try {
			const iconUrl = new URL(configuredIconUrl);
			if (iconUrl.protocol === 'https:') {
				return iconUrl.href;
			}
		} catch {
			// Ignore an invalid optional icon URL rather than breaking the feed.
		}
	}
	return '';
};


let renderRss2 = (content) => {
	let renderedText = mustache.render(rss2Template, content);
	return renderedText;
};

export { renderAtom, renderRss2, getSiteIconUrl };
