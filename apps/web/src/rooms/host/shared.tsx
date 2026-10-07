import { Link } from '@tanstack/react-router';
import { ApiError } from '../../lib/api';
import { useHostTransport } from './transport';
import type { HostConfigField } from '../../lib/types';

export const HOST_KEYS = {
    manager: ['host-manager'],
    features: ['host-features'],
    config: ['host-config'],
    lifecycle: ['host-lifecycle'],
    update: ['host-update'],
    audit: ['admin-audit']
} as const;

export type HostFailure = { code: string; message: string; details: Record<string, unknown> | null };

export function failureOf(error: unknown): HostFailure {
    if (error instanceof ApiError) {
        const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : null;
        return { code: error.code, message: error.message, details };
    }
    return { code: 'NETWORK', message: 'The portal could not be reached. It may be restarting; try again in a moment.', details: null };
}

const SOURCE_LABEL: Record<HostConfigField['source'], string> = {
    env: 'Environment',
    config: 'config.json',
    db: 'Database',
    default: 'Default',
    unset: 'Not set',
    'unknown-db': 'Database unreachable'
};

const SOURCE_CLASS: Record<HostConfigField['source'], string> = {
    env: 'state-unverified',
    config: 'state-verified',
    db: 'state-verified',
    default: '',
    unset: '',
    'unknown-db': 'state-revoked'
};

export function SourceBadge({ source }: { source: HostConfigField['source'] }) {
    return <span className={`badge ${SOURCE_CLASS[source] || ''}`} data-testid="source-badge" data-source={source}>{SOURCE_LABEL[source] || source}</span>;
}

/** The portal docs pages a recovery sentence can point at (slugs from apps/web/docs/manifest.json). */
export function DocLink({ slug, children, hash }: { slug: string; children: string; hash?: string }) {
    const transport = useHostTransport();
    if (transport) {
        const href = transport.docHref ? transport.docHref(slug, hash) : null;
        return href
            ? <a href={href} target="_blank" rel="noreferrer noopener" className="feature-doc-link">{children}</a>
            : <span className="hint">{children}</span>;
    }
    return <Link to="/docs/$slug" params={{ slug }} hash={hash} className="feature-doc-link">{children}</Link>;
}

/** Maps a catalog `help` value (an https link or a repo doc path) to something a person can follow. */
export function HelpLink({ help }: { help: string }) {
    if (!help) return null;
    if (/^https:\/\//.test(help)) return <a href={help} target="_blank" rel="noreferrer noopener" className="feature-doc-link">Where to get it</a>;
    const [path, anchor] = help.split('#');
    const slug = DOC_SLUGS[path];
    if (slug) return <DocLink slug={slug} hash={anchor}>More about this setting</DocLink>;
    return <span className="hint">See {path}</span>;
}

const DOC_SLUGS: Record<string, string> = {
    'documentation/host_operations.md': 'host-operations',
    'documentation/configuration.md': 'configuration',
    'documentation/identity.md': 'accounts',
    'documentation/webapp_setup.md': 'web-app',
    'documentation/manager.md': 'manager',
    'documentation/pwa.md': 'pwa',
    'documentation/discord_setup.md': 'discord',
    'documentation/code_sandbox.md': 'sandbox',
    'documentation/music_system.md': 'music'
};
