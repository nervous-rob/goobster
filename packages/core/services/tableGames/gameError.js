/** Illegal-move errors, presentable to the acting user. */
class GameError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GameError';
        this.code = code;
    }
}

module.exports = { GameError };
