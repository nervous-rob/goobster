/**
 * Brand names for the portal, so no component spells them itself.
 *
 * - `PRODUCT_NAME` is the application's name: the sidebar brand, the tab
 *   title, "Install … as an app", "… was updated". It is inlined at build
 *   time from apps/web/brand.config.cjs, the one rename point.
 * - `assistantName()` is the persona a person talks to: "Ask …", "… is
 *   thinking", "what … knows about you". It is runtime configuration
 *   (`identity.assistantName`, or the Discord bot's username when Discord
 *   is connected), published by the session (`me.assistant.name`) and the
 *   public config (`/api/app/config`). Until either has loaded it falls
 *   back to the product name.
 *
 * `assistantName()` is a plain getter rather than a hook so that labels,
 * placeholders and status maps can use it anywhere. The providers that load
 * the session and the public config call `setAssistantName` before any room
 * renders, and the name never changes within a session, so a re-render is
 * not needed for correctness.
 */

export const PRODUCT_NAME: string = typeof __PRODUCT_NAME__ === 'string' && __PRODUCT_NAME__.trim()
    ? __PRODUCT_NAME__.trim()
    : 'Goobster';

let current = PRODUCT_NAME;

/** Record the installation's assistant name (from `me.assistant.name` or the public config). */
export function setAssistantName(name: string | null | undefined): void {
    const trimmed = String(name ?? '').trim();
    current = trimmed || PRODUCT_NAME;
}

/** The assistant's name on this installation. */
export function assistantName(): string {
    return current;
}

/** Possessive form for copy such as "{name}'s guess". */
export function assistantPossessive(): string {
    const name = assistantName();
    return name.endsWith('s') ? `${name}'` : `${name}'s`;
}
