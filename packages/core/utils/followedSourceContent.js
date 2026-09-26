/** Bounded, provider-free normalization for followed RSS/Atom and HTML pages. */
const { load } = require('cheerio');
const { createHash } = require('node:crypto');
const { assessUrl } = require('./safeFetch');
const hash = text => createHash('sha256').update(String(text)).digest('hex');
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
const MAX_TEXT = 24000;
function publicLink(value, base) {
    if (!value || String(value).length > 2000) return null;
    try { const { url } = assessUrl(new URL(value, base).href); url.hash = ''; return url.href; }
    catch { return null; }
}
function plain(html) {
    const $ = load(String(html || '').slice(0, MAX_TEXT * 4));
    $('script,style,noscript,iframe,svg').remove();
    return clean($.text()).slice(0, MAX_TEXT);
}
function parseFeed(xml, url) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feed declarations are unsupported.');
    const $ = load(xml, { xml: true });
    const atom = $('feed').length > 0;
    if (!atom && !$('rss > channel').length) throw new Error('Expected an RSS or Atom feed.');
    const elements = atom ? $('feed > entry') : $('rss > channel > item');
    if (elements.length > 500) throw new Error('Feed exceeds the 500 item limit.');
    const entries = [];
    elements.each((index, element) => {
        const row = $(element);
        const rawLink = atom ? (row.children('link').filter((_i, el) => !$(el).attr('rel') || $(el).attr('rel') === 'alternate').first().attr('href')) : row.children('link').text();
        const link = publicLink(rawLink || '', url);
        const guid = clean(row.children(atom ? 'id' : 'guid').text()) || link;
        if (!guid) return;
        const title = plain(row.children('title').text()).slice(0, 240) || 'Untitled item';
        const published = row.children(atom ? 'published' : 'pubDate').text() || row.children('updated').text();
        const date = Date.parse(published);
        entries.push({ key: hash(guid), guid: guid.slice(0, 512), title, url: link || url,
            text: plain(row.children(atom ? 'content,summary' : 'description,content\\:encoded').first().text()).slice(0, 8000),
            publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
            author: plain(row.children(atom ? 'author' : 'author,dc\\:creator').text()).slice(0, 200), index });
    });
    if (elements.length && !entries.length) throw new Error('Feed items have no identifiers or links.');
    // Dated items sort newest first; undated feeds conventionally put the latest first.
    return entries.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0) || a.index - b.index);
}
function normalizePage(html) {
    const $ = load(html);
    $('script,style,noscript,nav,header,footer,aside,form,iframe,svg,time,[hidden],[aria-hidden="true"],[role="navigation"],[role="banner"],[role="contentinfo"],.date,.timestamp,.updated,.published,.cookie-banner').remove();
    const root = $('main,article,[role="main"]').first();
    const body = root.length ? root : $('body');
    const blocks = [];
    // Dates alone do not count as new prose, including dates inside a paragraph.
    const normalize = value => clean(value)
        .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:T[\d:.]+Z?)?\b/g, '[date]')
        .replace(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi, '[date]');
    let size = 0;
    body.find('h1,h2,h3,h4,h5,h6,p').each((_i, el) => {
        const text = normalize($(el).text()).slice(0, 4000);
        if (!text || size + text.length > MAX_TEXT) return;
        size += text.length;
        blocks.push({ kind: /^h\d$/.test(el.tagName) ? 'heading' : 'paragraph', text });
    });
    if (!blocks.length) throw new Error('No readable headings or paragraphs found.');
    const text = blocks.map(b => `${b.kind}: ${b.text}`).join('\n');
    return { blocks, text, hash: hash(text) };
}
function pageChange(previousText, current) {
    const old = new Set(String(previousText || '').split('\n'));
    // A new region must introduce a heading and substantive paragraph together.
    for (let i = 0; i < current.blocks.length; i++) {
        const heading = current.blocks[i];
        if (heading.kind !== 'heading' || old.has(`heading: ${heading.text}`)) continue;
        const paragraphs = [];
        for (let j = i + 1; j < current.blocks.length && current.blocks[j].kind !== 'heading'; j++) {
            const p = current.blocks[j].text;
            if (!old.has(`paragraph: ${p}`) && p.replace(/\[date\]/g, '').trim().length >= 40) paragraphs.push(p);
        }
        if (paragraphs.length) return { title: heading.text.slice(0, 240), text: paragraphs.join('\n\n').slice(0, 8000) };
    }
    return null;
}
module.exports = { parseFeed, normalizePage, pageChange, hash, publicLink };
