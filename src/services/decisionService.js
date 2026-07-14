// Decision service — fair random helpers using crypto.randomInt + Fisher-Yates.
const crypto = require('crypto');

/** Get a secure random integer in [min, max] inclusive. */
function randomInt(min, max) {
    return crypto.randomInt(min, max + 1);
}

/** Fisher-Yates shuffle in-place. Mutates and returns arr. */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = randomInt(0, i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** Pick one random element from array. */
function pick(arr) {
    if (!arr.length) return null;
    return arr[randomInt(0, arr.length - 1)];
}

/** Shuffle and split array into N roughly equal teams. */
function splitTeams(items, teamCount) {
    if (teamCount < 2) throw new Error('Minimal 2 tim');
    if (items.length < teamCount) throw new Error(`Butuh minimal ${teamCount} peserta`);

    const shuffled = shuffle([...items]);
    const teams = Array.from({ length: teamCount }, () => []);

    for (let i = 0; i < shuffled.length; i++) {
        teams[i % teamCount].push(shuffled[i]);
    }

    return teams;
}

/** Roll a dice with N sides (default 6). */
function rollDice(sides = 6) {
    if (sides < 2 || sides > 1000) throw new Error('Sisi dadu harus 2–1000');
    return randomInt(1, sides);
}

/** Flip a coin. */
function flipCoin() {
    return randomInt(0, 1) === 0 ? 'Kepala' : 'Ekor';
}

/** Generate a random number in [min, max]. */
function randomNumber(min, max) {
    if (min > max) [min, max] = [max, min];
    return randomInt(min, max);
}

/** Shuffle and create random pairs. If odd, last person goes solo. */
function makePairs(items) {
    const shuffled = shuffle([...items]);
    const pairs = [];
    for (let i = 0; i < shuffled.length; i += 2) {
        if (i + 1 < shuffled.length) {
            pairs.push({ pair: [shuffled[i], shuffled[i + 1]], type: 'pair' });
        } else {
            pairs.push({ pair: [shuffled[i]], type: 'solo' });
        }
    }
    return pairs;
}

/** Sort items into random order (alias for shuffle without mutation). */
function randomizeOrder(arr) {
    return shuffle([...arr]);
}

module.exports = {
    randomInt, shuffle, pick,
    splitTeams, rollDice, flipCoin,
    randomNumber, makePairs, randomizeOrder,
};
