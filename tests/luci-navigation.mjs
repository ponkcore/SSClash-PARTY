#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceRoot = new URL('../luci-app-ssclash/rootfs/', import.meta.url);
const menuPath = new URL('usr/share/luci/menu.d/luci-app-ssclash.json', sourceRoot);
const settingsPath = new URL('www/luci-static/resources/view/ssclash/settings.js', sourceRoot);
const routerPath = new URL('www/luci-static/resources/view/ssclash/router.js', sourceRoot);
const configPath = new URL('www/luci-static/resources/view/ssclash/config.js', sourceRoot);
const templatesPath = new URL('www/luci-static/resources/view/ssclash/templates.js', sourceRoot);
const landingPath = new URL('www/ssclash-party-index.html', sourceRoot);

const menu = JSON.parse(await readFile(menuPath, 'utf8'));
const dashboardRoute = menu['admin/services/ssclash/dashboard'];
const routerRoute = menu['admin/services/ssclash/router'];
const rulesetsRoute = menu['admin/services/ssclash/rulesets'];

assert.equal(dashboardRoute.title, undefined, 'Dashboard must not appear as a LuCI tab');
assert.equal(dashboardRoute.firstchild_ineligible, true);
assert.deepEqual(dashboardRoute.action, {
    type: 'view',
    path: 'ssclash/dashboard'
});

assert.equal(routerRoute.title, undefined, 'Router Integration must not appear as a LuCI tab');
assert.equal(routerRoute.firstchild_ineligible, true);
assert.deepEqual(routerRoute.action, {
    type: 'alias',
    path: 'admin/services/ssclash/settings'
});

assert.equal(rulesetsRoute.title, undefined, 'Legacy Rulesets must not appear as a LuCI tab');
assert.equal(rulesetsRoute.firstchild_ineligible, true);
assert.deepEqual(rulesetsRoute.action, {
    type: 'alias',
    path: 'admin/services/ssclash/templates'
});

const visibleTabs = Object.entries(menu)
    .filter(([path, entry]) => path.startsWith('admin/services/ssclash/') && entry.title)
    .map(([, entry]) => entry.title)
    .sort();
assert.deepEqual(visibleTabs, [ 'Configuration', 'Log', 'Settings', 'Templates' ]);

const settings = await readFile(settingsPath, 'utf8');
const router = await readFile(routerPath, 'utf8');
const config = await readFile(configPath, 'utf8');
const templates = await readFile(templatesPath, 'utf8');
const landing = await readFile(landingPath, 'utf8');

assert.match(settings, /'require view\.ssclash\.router';/);
assert.match(settings, /view_ssclash_router\.load\(\)/);
assert.match(settings, /view_ssclash_router\.render\(routerData\)/);
assert.doesNotMatch(settings, /admin\/services\/ssclash\/router/);
assert.match(router, /'require baseclass';/);
assert.doesNotMatch(router, /'require view';/);
assert.match(router, /return baseclass\.extend\(\{/);
assert.match(router, /fakeip-whitelist-ipcidr\.txt/);
assert.match(config, /L\.url\('admin\/services\/ssclash\/dashboard'\)/);
assert.match(config, /ssclash-template-manager/);
assert.match(config, /_\('Open Dashboard'\)/);
assert.match(templates, /return view\.extend\(\{/);
assert.match(templates, /'prepare'/);
assert.match(templates, /'save'/);
assert.match(templates, /inline provider/);
assert.match(templates, /_\('New template'\)/);
assert.doesNotMatch(templates, /New visual template/);
assert.match(templates, /ssclash-party-rule-card/);
assert.match(templates, /ssclash-party-rule-header/);
assert.match(templates, /ssclash-party-rule-fields/);
assert.match(templates, /ssclash-party-rule-actions/);
assert.doesNotMatch(templates, /grid-template-columns: 42px minmax\(300px,1fr\)/);
assert.match(landing, /admin\/services\/ssclash\/dashboard/);

console.log('LuCI navigation contract passed');
