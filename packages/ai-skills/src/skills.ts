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
    requiredCapabilities: ['schema:write'],
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
    requiredCapabilities: ['schema:write'],
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
    requiredCapabilities: ['schema:write'],
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
    requiredCapabilities: ['schema:write'],
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
};
