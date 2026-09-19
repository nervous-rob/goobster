declare const markdown: {
    createMarkdownRenderer: (deps: { highlight?: (code: string, lang: string) => string }) => (source: string) => string;
    escapeHtml: (text: string) => string;
    renderInline: (text: string) => string;
    parseListItem: (line: string) => { type: 'ul' | 'ol'; indent: number; number: number | null; text: string } | null;
};
export default markdown;
