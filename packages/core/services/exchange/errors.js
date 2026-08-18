/**
 * User-presentable exchange errors (machine-readable code + a message safe to
 * show in a Discord reply), mirroring EconomyError/StockError so commands and
 * tools can surface `error.message` directly.
 */
class ExchangeError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'ExchangeError';
        this.code = code;
    }
}

module.exports = { ExchangeError };
