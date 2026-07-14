// Quiz service — trivia questions from Open Trivia DB + JService (Jeopardy!).
// Used for auto-quiz (1x/day via cron) and manual !quiz command.

const { hasSent, markSent, hashContent } = require('../utils/contentHistory');

// ── Config ───────────────────────────────────────────────

const TIMEOUT_MS = 8000;

// ── API Sources ──────────────────────────────────────────

const SOURCES = [
    {
        name: 'Open Trivia DB',
        url: 'https://opentdb.com/api.php?amount=1&type=multiple',
        fetch: async (logger) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            try {
                const res = await fetch(
                    'https://opentdb.com/api.php?amount=1&type=multiple&encode=base64',
                    { signal: controller.signal }
                );
                if (!res.ok) return null;
                const data = await res.json();
                if (!data.results?.[0]) return null;

                const q = data.results[0];
                // Decode base64 if encoded
                const decode = (s) => Buffer.from(s, 'base64').toString('utf8');
                const question = q.question.includes('=') ? decode(q.question) : q.question;
                const correct = q.correct_answer.includes('=') ? decode(q.correct_answer) : q.correct_answer;
                const incorrect = q.incorrect_answers.map(a => a.includes('=') ? decode(a) : a);

                // Shuffle answers
                const answers = shuffle([correct, ...incorrect]);
                const correctIndex = answers.indexOf(correct);

                return formatTriviaResult({
                    question,
                    answers,
                    correctIndex,
                    difficulty: q.difficulty,
                    category: q.category.includes('=') ? decode(q.category) : q.category,
                    source: 'Open Trivia DB'
                });
            } finally {
                clearTimeout(timer);
            }
        }
    },
    {
        name: 'JService',
        url: 'https://jservice.io/api/random',
        fetch: async (logger) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            try {
                const res = await fetch(
                    'https://jservice.io/api/random',
                    { signal: controller.signal, headers: { Accept: 'application/json' } }
                );
                if (!res.ok) return null;
                const data = await res.json();
                if (!data?.[0]) return null;

                const q = data[0];
                // JService returns a Jeopardy! clue — we need to make it multiple choice
                // We'll use it as an open-ended "guess the question" format
                return formatJServiceResult({
                    answer: q.answer,
                    question: q.question, // This is the "question" in Jeopardy format
                    value: q.value,
                    category: q.category?.title || 'Jeopardy',
                    source: 'Jeopardy! (JService)'
                });
            } finally {
                clearTimeout(timer);
            }
        }
    }
];

// ── Helpers ──────────────────────────────────────────────

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

function formatTriviaResult({ question, answers, correctIndex, difficulty, category, source }) {
    const emojiDifficulty = { easy: '🟢', medium: '🟡', hard: '🔴' };
    const diffLabel = emojiDifficulty[difficulty] || '⚪';

    const lines = [
        `🧠 *Trivia Quiz* ${diffLabel}`,
        `📂 ${category}`,
        ``,
        `*${decodeHTMLEntities(question)}*`,
        ``
    ];

    const labels = ['A', 'B', 'C', 'D'];
    answers.forEach((ans, i) => {
        lines.push(`${labels[i]}. ${decodeHTMLEntities(ans)}`);
    });

    lines.push('');
    lines.push(`_Jawab dengan huruf A/B/C/D — jawaban muncul dalam 30 detik!_`);

    return {
        text: lines.join('\n'),
        correctAnswer: labels[correctIndex],
        correctText: decodeHTMLEntities(answers[correctIndex]),
        source,
        category,
        difficulty
    };
}

function formatJServiceResult({ answer, question, value, category, source }) {
    // Generate fake wrong answers for multiple choice
    const correct = decodeHTMLEntities(question);
    const distractors = generateDistractors(correct);
    const answers = shuffle([correct, ...distractors]);
    const correctIndex = answers.indexOf(correct);
    const labels = ['A', 'B', 'C', 'D'];

    const lines = [
        `🧠 *Jeopardy! Trivia* 🎯`,
        `📂 ${category}${value ? ` • $${value}` : ''}`,
        ``,
        `*${decodeHTMLEntities(answer)}*`,
        ``
    ];

    answers.forEach((ans, i) => {
        lines.push(`${labels[i]}. ${ans}`);
    });

    lines.push('');
    lines.push(`_Jawab dengan huruf A/B/C/D — jawaban muncul dalam 30 detik!_`);

    return {
        text: lines.join('\n'),
        correctAnswer: labels[correctIndex],
        correctText: correct,
        source,
        category,
        difficulty: 'medium',
        format: 'multiple'
    };
}

/**
 * Generate 3 fake distractors for multiple choice.
 * Simple approach: vary word order, insert common wrong-but-plausible alternatives.
 */
function generateDistractors(correct) {
    const pool = [
        correct + ' (tidak tepat)',
        correct.replace(/^(The|A|An)\s/i, ''),
        'Semua jawaban benar',
        'Tidak ada yang benar',
        correct.split(' ').slice(0, -1).join(' ') + ' ?',
        correct.replace(/\d+/g, (n) => String(Number(n) + 1 + Math.floor(Math.random() * 5))),
    ];

    // Shuffle and pick 3 that are different from correct
    const unique = pool.filter(d => d !== correct);
    while (unique.length < 3) unique.push(`Bukan ${correct.slice(0, 15)}...`);
    return shuffle(unique).slice(0, 3);
}

function decodeHTMLEntities(text) {
    if (!text) return '';
    return text
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#039;/g, "'")
        .replace(/&eacute;/g, 'é')
        .replace(/&rsquo;/g, "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&hellip;/g, '...')
        .replace(/&oacute;/g, 'ó')
        .replace(/&aacute;/g, 'á')
        .replace(/&iacute;/g, 'í')
        .replace(/&uacute;/g, 'ú')
        .replace(/&ntilde;/g, 'ñ');
}

// ── Public API ───────────────────────────────────────────

/**
 * Get one random trivia question.
 * Tries Open Trivia DB first, falls back to JService.
 *
 * @param {Object} options
 * @param {Object} options.logger
 * @returns {Promise<{text: string, correctAnswer: string, correctText: string}|null>}
 */
async function getTriviaQuestion(options = {}) {
    const { logger } = options;

    // Try sources in random order
    const shuffledSources = shuffle([...SOURCES]);

    for (const source of shuffledSources) {
        try {
            logger?.info(`Quiz: trying ${source.name}...`);
            const result = await source.fetch(logger);
            if (result) {
                // Dedup by question text
                const id = hashContent(result.text);
                if (hasSent(id)) {
                    logger?.info(`Quiz: duplicate from ${source.name}, trying next`);
                    continue;
                }
                markSent(id);
                logger?.info(`Quiz: fetched from ${source.name}`);
                return result;
            }
        } catch (err) {
            logger?.warn({ err, source: source.name }, 'Quiz source failed');
        }
    }

    logger?.warn('All quiz sources exhausted');
    return null;
}

module.exports = {
    getTriviaQuestion
};
