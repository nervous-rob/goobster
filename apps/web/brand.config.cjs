/**
 * The product's name, in one place.
 *
 * This is the rename point for the portal and the setup client: the Vite
 * builds inline it as `__PRODUCT_NAME__` (read through src/lib/brand.ts),
 * substitute it into index.html / setup.html, and rewrite the static PWA
 * files (manifest, offline page, service worker) in dist. Nothing under
 * apps/web/src may spell the product name itself - tests/portalBrand.test.js
 * enforces that.
 *
 * The *assistant's* name is separate and runtime: `identity.assistantName`
 * in config.json (packages/core/config/identityConfig.js), carried to the
 * client on /api/app/me and /api/app/config. By default both are the same
 * word; a rebrand may keep the assistant persona and change only this file.
 *
 * CommonJS so both Vite configs and Jest can require it.
 */
module.exports = {
    productName: 'Goobster'
};
