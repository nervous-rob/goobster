/** Read the drag store synchronously: browsers hide it after the drop event. */
export type DroppedLink = { url: string; name: string; image?: boolean; download?: boolean };
export type AttachmentDrop = { files: File[]; links: DroppedLink[]; warnings: string[] };
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export function isAttachmentDrag(data: DataTransfer | null): boolean {
    const types = Array.from(data?.types || []);
    return types.some(type => ['Files', 'text/uri-list', 'text/x-moz-url'].includes(type));
}

function webUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}

export function readAttachmentDrop(data: DataTransfer): AttachmentDrop {
    const result: AttachmentDrop = { files: [], links: [], warnings: [] };
    const items = Array.from(data.items || []).filter(item => item.kind === 'file');
    if (items.length) {
        for (const item of items) {
            if (item.webkitGetAsEntry?.()?.isDirectory) {
                result.warnings.push('Folders cannot be attached. Drop the files inside the folder instead.');
                continue;
            }
            const file = item.getAsFile();
            if (file) result.files.push(file);
        }
    } else result.files = Array.from(data.files || []);
    // A dragged browser image can expose both a File and its URL. Take it once.
    if (items.length || result.files.length) return result;
    const template = document.createElement('template');
    template.innerHTML = data.getData('text/html'); // inert; never inserted or rendered
    const img = template.content.querySelector('img');
    const imageUrl = webUrl(img?.getAttribute('src') || '');
    if (imageUrl) result.links.push({ url: imageUrl, name: img?.getAttribute('alt') || 'Web image', image: true });
    else {
        const urls = data.getData('text/uri-list').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
        if (!urls.length) urls.push(data.getData('text/x-moz-url').split('\n')[0] || data.getData('text/plain'));
        if (!urls.some(Boolean)) urls.push(template.content.querySelector('a')?.getAttribute('href') || '');
        for (const raw of urls) {
            const url = webUrl(raw.trim());
            if (url && !result.links.some(link => link.url === url)) {
                const path = new URL(url).pathname;
                const image = /\.(png|jpe?g|webp|gif)$/i.test(path);
                const download = image || /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|json|zip|mp3|wav|mp4)$/i.test(path);
                result.links.push({ url, name: download ? path.split('/').pop() || 'Web file' : new URL(url).hostname, image, download });
            }
        }
    }
    if (!result.links.length) result.warnings.push('This item does not contain a usable file or HTTP(S) link. Save it to your device, then drop the file.');
    return result;
}

/** Copy public web files in the browser only. Never proxy arbitrary URLs on the server. */
export async function resolveAttachmentDrop(drop: AttachmentDrop, signal: AbortSignal): Promise<AttachmentDrop> {
    const result = { files: [...drop.files], links: [] as DroppedLink[], warnings: [...drop.warnings] };
    for (const link of drop.links) {
        if (!link.image && !link.download) { result.links.push(link); continue; }
        try {
            const response = await fetch(link.url, {
                mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            });
            const type = response.headers.get('content-type')?.split(';')[0].trim() || '';
            if (!response.ok || !response.body || (link.image && !/^image\/(png|jpeg|webp|gif)$/.test(type))
                || type === 'text/html') {
                await response.body?.cancel();
                throw new Error('Unavailable file');
            }
            if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_BYTES) {
                await response.body.cancel();
                throw new Error('Image too large');
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let size = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    size += chunk.value.byteLength;
                    if (size > MAX_ATTACHMENT_BYTES) throw new Error('Image too large');
                    chunks.push(chunk.value);
                }
            } finally { await reader.cancel().catch(() => {}); }
            const original = decodeURIComponent(new URL(link.url).pathname.split('/').pop() || 'web-file');
            const name = link.image ? `${original.replace(/\.[^.]+$/, '')}.${type === 'image/jpeg' ? 'jpg' : type.slice(6)}` : original;
            result.files.push(new File(chunks, name, { type }));
        } catch {
            if (signal.aborted) throw new DOMException('Drop cancelled', 'AbortError');
            result.links.push({ ...link, image: false, download: false });
            result.warnings.push('The website did not allow copying this file, or it exceeded the 8 MB limit. The source link was kept instead.');
        }
    }
    return result;
}

export function markdownLink(link: DroppedLink): string {
    const name = link.name.replace(/[\[\]\\\r\n]/g, '_').slice(0, 120);
    return `[${name}](<${link.url.replace(/[<>()]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())}>)`;
}
