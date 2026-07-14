// Shared quiz state — accessible by both handler (for answer checking)
// and scheduler (for auto-quiz). One quiz active per chat at a time.

const activeQuizzes = new Map();

module.exports = { activeQuizzes };
