// Pure, local section search. No user data, network calls, or provider costs.
function normalize(text) {
    return String(text).replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function searchDocumentation(pages, query, limit = 30) {
    const words = [...new Set(normalize(String(query).slice(0, 200)).split(/\s+/).filter(Boolean))];
    if (!words.length) return [];
    const results = [];
    for (const page of pages) {
        const title = normalize(page.title);
        for (const section of page.sections) {
            const heading = normalize(section.heading);
            const body = normalize(section.text);
            if (!words.every((word) => `${title} ${heading} ${body}`.includes(word))) continue;
            const score = words.reduce((total, word) => total + (title.includes(word) ? 8 : 0)
                + (heading.includes(word) ? 5 : 0) + (body.includes(word) ? 1 : 0), 0);
            const first = section.text.toLowerCase().indexOf(words[0]);
            const start = Math.max(0, first - 60);
            const excerpt = (start ? '…' : '') + section.text.slice(start, start + 180)
                + (section.text.length > start + 180 ? '…' : '');
            results.push({ pageId: page.id, title: page.title, group: page.group, anchor: section.anchor,
                heading: section.heading, excerpt, score });
        }
    }
    return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

module.exports = { searchDocumentation };
