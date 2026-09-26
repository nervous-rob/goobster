/* Build-only documentation compiler. Never import runtime config or self_docs. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const process = require('node:process');
const MarkdownIt = require('markdown-it');
const YAML = require('yaml');
const manifest = require('./manifest.json');

const REPO = 'https://github.com/nervous-rob/goobster';

function sourceFile(root, source) {
    if (source !== 'README.md' && !/^documentation\/(?:[\w-]+\/)*[\w.-]+\.md$/.test(source)) {
        throw new Error(`Documentation source is not public Markdown: ${source}`);
    }
    let current = root;
    for (const part of source.split('/')) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Documentation symlink refused: ${source}`);
    }
    return current;
}

function revisionAt(root) {
    const supplied = process.env.GOOBSTER_DOCS_REVISION;
    if (supplied && /^[a-f0-9]{40}$/i.test(supplied)) return supplied;
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
}

function bodyOf(source, name) {
    const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!text.startsWith('---\n')) return text;
    const end = text.indexOf('\n---\n', 4);
    if (end < 0) throw new Error(`Unclosed documentation front matter: ${name}`);
    const meta = YAML.parse(text.slice(4, end));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`Invalid documentation front matter: ${name}`);
    return text.slice(end + 5);
}

function anchorBase(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s/g, '-') || 'section';
}

function inlineText(token) {
    return (token.children || []).map((child) => child.type === 'softbreak' || child.type === 'hardbreak' ? ' ' : child.content || '').join('');
}

function resolveLink(href, source, bySource, revision, image = false) {
    // No protocol-relative URLs, backslashes, or control characters.
    if (/^\s*\/\//.test(href) || href.includes('\\') || [...href].some((char) => char.charCodeAt(0) <= 32)) return null;
    if (/^https?:\/\//i.test(href) || (!image && /^mailto:/i.test(href))) return href;
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) return null;
    if (!image && href.startsWith('#')) return href;
    if (!image && /^\/app(?:\/|$)/.test(href)) return href;
    if (href.startsWith('/')) return null;
    const match = href.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
    if (!match) return null;
    let decoded;
    try { decoded = decodeURIComponent(match[1]); } catch { return null; }
    if (decoded.includes('\\') || [...decoded].some((char) => char.charCodeAt(0) < 32)) return null;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), decoded));
    if (target.startsWith('../') || path.posix.isAbsolute(target)) return null;
    const hash = match[3] || '';
    const page = bySource.get(target);
    if (!image && page) return `/app/docs/${page.id}${hash}`;
    const escapedPath = target.split('/').map(encodeURIComponent).join('/');
    if (image) return `https://raw.githubusercontent.com/nervous-rob/goobster/${revision || 'main'}/${escapedPath}`;
    return `${REPO}/blob/${revision || 'main'}/${escapedPath}${match[2] || ''}${hash}`;
}

function renderPage(page, source, bySource, revision) {
    const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
    const originalLink = md.renderer.rules.link_open;
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const href = resolveLink(token.attrGet('href') || '', page.source, bySource, revision);
        token.attrs = (token.attrs || []).filter(([key]) => key !== 'href');
        if (href) token.attrSet('href', href);
        if (href && /^https?:/i.test(href)) {
            token.attrSet('target', '_blank');
            token.attrSet('rel', 'noopener noreferrer');
        }
        return originalLink ? originalLink(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };
    const originalImage = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const src = resolveLink(token.attrGet('src') || '', page.source, bySource, revision, true);
        if (!src) return md.utils.escapeHtml(token.content);
        token.attrSet('src', src);
        token.attrSet('loading', 'lazy');
        token.attrSet('referrerpolicy', 'no-referrer');
        return originalImage(tokens, idx, options, env, self);
    };
    const tokens = md.parse(bodyOf(source, page.source), {});
    const headings = [];
    const sections = [{ anchor: '', heading: page.title, text: '' }];
    const used = new Set();
    const trail = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'heading_open') {
            const level = Number(token.tag.slice(1));
            const title = inlineText(tokens[i + 1]);
            const base = anchorBase(title);
            let anchor = base;
            let suffix = 0;
            while (used.has(anchor)) anchor = `${base}-${++suffix}`;
            used.add(anchor);
            token.attrSet('id', anchor);
            token.attrSet('tabindex', '-1');
            trail.length = level - 1;
            trail[level - 1] = title;
            headings.push({ level, title, anchor });
            sections.push({ anchor, heading: trail.filter(Boolean).join(' › '), text: '' });
            i++; // heading text is already in the breadcrumb
        } else if (token.type === 'inline' || token.type === 'fence' || token.type === 'code_block') {
            sections[sections.length - 1].text += ` ${token.type === 'inline' ? inlineText(token) : token.content}`;
        }
    }
    return {
        ...page,
        sourceUrl: `${REPO}/blob/${revision || 'main'}/${page.source}`,
        html: md.renderer.render(tokens, md.options, {}),
        headings,
        sections: sections.map((section) => ({ ...section, text: section.text.replace(/\s+/g, ' ').trim() }))
    };
}

function buildDocumentation(root, groups = manifest, revision = revisionAt(root)) {
    const ids = new Set();
    const bySource = new Map();
    const pages = [];
    for (const group of groups) {
        for (const [id, title, source] of group.pages) {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id) || bySource.has(source)) {
                throw new Error(`Duplicate or invalid documentation entry: ${id}`);
            }
            const page = { id, title, source, group: group.title };
            ids.add(id);
            bySource.set(source, page);
            pages.push(page);
        }
    }
    return {
        revision,
        groups: groups.map((group) => ({ title: group.title, ids: group.pages.map(([id]) => id) })),
        pages: pages.map((page) => renderPage(page, fs.readFileSync(sourceFile(root, page.source), 'utf8'), bySource, revision))
    };
}

module.exports = { buildDocumentation, renderPage, resolveLink, sourceFile, anchorBase };
