// ESM façade over the CommonJS renderer (unit-tested under Jest) that
// injects the browser-side syntax highlighter.
import markdown from './markdown.cjs';
import { highlight } from './highlight.js';

/**
 * Render markdown to safe HTML.
 * @type {(source: string) => string}
 */
export const renderMarkdown = markdown.createMarkdownRenderer({ highlight });
