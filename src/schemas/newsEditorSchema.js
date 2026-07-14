// JSON Schema for Groq News Editor structured output.
// Uses strict mode — all fields required, no additional properties.
//
// IMPORTANT: Do NOT add optional fields, nullable fields, URL fields,
// source fields, nested objects, or dynamic schema conditions.
// Schema complexity is kept minimal to reduce request errors.

const NEWS_EDITOR_SCHEMA = {
  type: "object",
  additionalProperties: false,

  properties: {
    selected: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          id: {
            type: "string"
          },

          displayTitle: {
            type: "string"
          },

          summary: {
            type: "string"
          },

          category: {
            type: "string",

            enum: [
              "politik",
              "ekonomi",
              "kesehatan",
              "pendidikan",
              "teknologi",
              "sains",
              "lingkungan",
              "hukum",
              "bencana",
              "keamanan",
              "internasional",
              "lainnya"
            ]
          },

          importance: {
            type: "integer"
          }
        },

        required: [
          "id",
          "displayTitle",
          "summary",
          "category",
          "importance"
        ]
      }
    },

    rejectedIds: {
      type: "array",

      items: {
        type: "string"
      }
    }
  },

  required: [
    "selected",
    "rejectedIds"
  ]
};

module.exports = { NEWS_EDITOR_SCHEMA };
