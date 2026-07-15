// Compatibility facade for existing News/Reddit/FX schedulers.
// The durable takeover state and event idempotency live in birthdayService.
const birthday = require("./birthdayService");

module.exports = {
  shouldSuppressCron: birthday.shouldSuppressCron,
  recordWishFromMessage: birthday.recordWishFromMessage,
};
