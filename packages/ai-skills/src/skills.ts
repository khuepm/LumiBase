import type { AISkillDefinition } from './types';

export const CORE_SKILLS: Record<string, AISkillDefinition> = {
  listCollections: {
    name: 'listCollections',
    description: 'Lists all data collections configured in the CMS schema.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    requiredCapabilities: ['schema:read'],
  },

  createCollection: {
    name: 'createCollection',
    description: 'Creates a new data collection (table) in the database schema.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The unique snake_case name of the collection (e.g., blog_posts, products).',
        },
        description: {
          type: 'string',
          description: 'Optional human-readable description of the collection.',
        },
      },
      required: ['name'],
    },
    requiredCapabilities: ['schema:create'],
  },

  deleteCollection: {
    name: 'deleteCollection',
    description: 'Permanently deletes a collection and all its associated data.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the collection to delete.',
        },
      },
      required: ['name'],
    },
    requiredCapabilities: ['schema:delete'],
  },

  createField: {
    name: 'createField',
    description: 'Appends a new field (column) to an existing collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The name of the collection to add the field to.',
        },
        name: {
          type: 'string',
          description: 'The unique snake_case name of the field (e.g., publish_date, author_id).',
        },
        type: {
          type: 'string',
          description: 'The data type of the field.',
          enum: ['string', 'text', 'integer', 'float', 'boolean', 'json', 'dateTime'],
        },
        required: {
          type: 'boolean',
          description: 'Whether the field is mandatory (not null).',
        },
      },
      required: ['collection', 'name', 'type'],
    },
    requiredCapabilities: ['schema:update'],
  },

  deleteField: {
    name: 'deleteField',
    description: 'Deletes a field from an existing collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The name of the collection.',
        },
        name: {
          type: 'string',
          description: 'The name of the field to delete.',
        },
      },
      required: ['collection', 'name'],
    },
    requiredCapabilities: ['schema:delete'],
  },

  listItems: {
    name: 'listItems',
    description: 'Queries and returns a list of items from a specified collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The name of the collection to query.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of items to retrieve (default: 20).',
        },
        offset: {
          type: 'integer',
          description: 'Number of items to skip.',
        },
      },
      required: ['collection'],
    },
    requiredCapabilities: ['items:read'],
  },

  createItem: {
    name: 'createItem',
    description: 'Inserts a new data record into a specified collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The name of the collection to insert into.',
        },
        data: {
          type: 'object',
          description: 'The JSON key-value payload matching the collection fields.',
        },
      },
      required: ['collection', 'data'],
    },
    requiredCapabilities: ['items:create'],
  },

  updateItem: {
    name: 'updateItem',
    description: 'Updates an existing data record inside a collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The collection name.',
        },
        id: {
          type: 'string',
          description: 'The ID of the item to update.',
        },
        data: {
          type: 'object',
          description: 'The partial JSON payload containing updated values.',
        },
      },
      required: ['collection', 'id', 'data'],
    },
    requiredCapabilities: ['items:update'],
  },

  deleteItem: {
    name: 'deleteItem',
    description: 'Permanently deletes a record from a collection by its ID.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The collection name.',
        },
        id: {
          type: 'string',
          description: 'The ID of the record to delete.',
        },
      },
      required: ['collection', 'id'],
    },
    requiredCapabilities: ['items:delete'],
  },

  // ── POST-GA Task #3 — RAG Skills ─────────────────────────────────────────

  aiSuggestField: {
    name: 'aiSuggestField',
    description:
      'Suggests field definitions for a collection based on its description and existing schema. ' +
      'Uses RAG to find similar collections and field patterns for better suggestions.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The name of the collection to suggest fields for.',
        },
        description: {
          type: 'string',
          description:
            'A natural language description of what the collection stores (e.g. "blog posts with title, body, author, and publish date").',
        },
        maxSuggestions: {
          type: 'integer',
          description: 'Maximum number of field suggestions to return (default: 5).',
        },
      },
      required: ['collection', 'description'],
    },
    requiredCapabilities: ['schema:read'],
  },

  aiContentAssist: {
    name: 'aiContentAssist',
    description:
      'Generates or edits content for a specific field using AI. Uses RAG to find relevant ' +
      'context from existing items in the same collection for consistent style and terminology.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The collection name.',
        },
        itemId: {
          type: 'string',
          description: 'The ID of the item to assist with (optional for new items).',
        },
        fieldName: {
          type: 'string',
          description: 'The field to generate/edit content for.',
        },
        instruction: {
          type: 'string',
          description:
            'What to do with the content (e.g. "write a SEO-friendly title", "translate to Vietnamese", "make it shorter").',
        },
        currentContent: {
          type: 'string',
          description: 'The current content of the field, if editing.',
        },
      },
      required: ['collection', 'fieldName', 'instruction'],
    },
    requiredCapabilities: ['items:read'],
  },
};
