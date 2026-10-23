import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../src/route.js', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const retiredPlugin = new URL('../src/lib/xiaohongshu/user.js', import.meta.url);

test('does not register or retain the retired Xiaohongshu route', () => {
	assert.doesNotMatch(routeSource, /xiaohongshu|小红书/i);
	assert.doesNotMatch(readme, /xiaohongshu|小红书|XIAOHONGSHU_COOKIE/i);
	assert.equal(existsSync(retiredPlugin), false);
});
