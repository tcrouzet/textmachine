const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveLocale, setLocale, t } = require('../../plugin/i18n');
const en = require('../../locales/en.json');
const fr = require('../../locales/fr.json');

test('English and French catalogs cover every used key with matching placeholders', () => {
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
    const parameters = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const key of Object.keys(en)) {
        assert.ok(en[key].trim() && fr[key].trim(), key);
        assert.deepEqual(parameters(fr[key]), parameters(en[key]), key);
    }
    const used = new Set();
    for (const file of ['plugin/main.ts', 'plugin/gmail.js', 'plugin/articles.js', 'plugin/crawler.js', 'plugin/browser.js', 'plugin/ai/config.js', 'plugin/ai/settings.js', 'plugin/ai/codex.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
        for (const match of source.matchAll(/\bt\('([^']+)'/g)) {
            assert.ok(Object.hasOwn(en, match[1]), `${file}: ${match[1]}`);
            used.add(match[1]);
        }
    }
    assert.deepEqual([...used].sort(), Object.keys(en).sort());
});

test('resolves regional locales, falls back to English and interpolates whole messages', () => {
    for (const language of ['fr', 'FR-fr', 'fr_CA']) assert.equal(resolveLocale(language), 'fr');
    for (const language of ['en-GB', 'de', '', undefined]) assert.equal(resolveLocale(language), 'en');
    setLocale('en');
    assert.equal(t('createFolder'), 'Create folder');
    assert.equal(t('journalReady', {path:'Research/log.md'}), 'File ready: Research/log.md.');
    setLocale('fr');
    assert.equal(t('createFolder'), 'Créer le dossier');
    assert.equal(t('labelAccessible', {name:'News', count:1234}), '« News » accessible. Messages : ' + new Intl.NumberFormat('fr').format(1234) + '.');
    assert.throws(() => t('journalReady'), /Missing translation parameter/);
    setLocale('de');
    assert.equal(t('cancel'), 'Cancel');
});
