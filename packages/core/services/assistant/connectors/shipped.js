/**
 * The connectors this installation ships with (ADR 0028): Notion, by the
 * owner's decision recorded in its manifest (ADR 0030).
 *
 * To add one, require its module here. Its manifest must carry the owner's
 * recorded decision (`decision`), or `register()` refuses it at startup.
 */

module.exports = [
    require('./notion')
];
