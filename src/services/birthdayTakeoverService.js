// Birthday Takeover Service — checks if a scheduled delivery should be suppressed.
// Stub: returns false (no takeover) until birthday feature is deployed.
// When birthday feature is added, replace with actual implementation.

async function shouldSuppressCron(groupJid, jobName) {
  return false;
}

module.exports = { shouldSuppressCron };
