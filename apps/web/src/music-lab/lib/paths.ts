export const CONSERVATORY_BASE = '/conservatory';

export function conservatoryPath(tool = ''): string {
    if (!tool || tool === '/') return CONSERVATORY_BASE;
    return `${CONSERVATORY_BASE}${tool.startsWith('/') ? tool : `/${tool}`}`;
}

export function isConservatoryPath(pathname: string, tool = ''): boolean {
    const target = conservatoryPath(tool);
    if (tool === '' || tool === '/') return pathname === CONSERVATORY_BASE || pathname === `${CONSERVATORY_BASE}/`;
    return pathname === target || pathname.startsWith(`${target}/`);
}
