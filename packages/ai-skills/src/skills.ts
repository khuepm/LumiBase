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

  generateAppSpec: {
    name: 'generateAppSpec',
    description: 'Generate page and component specs from selected collections.',
    parameters: {
      type: 'object',
      properties: {
        collections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Collection names to include in the spec.',
        },
        targetApp: {
          type: 'string',
          description: 'Target application type (e.g. storefront, dashboard).',
        },
      },
      required: [],
    },
    requiredCapabilities: ['schema:read', 'items:read'],
  },

  generateApiDocs: {
    name: 'generateApiDocs',
    description: 'Generate an OpenAPI documentation artifact from the schema and permissions.',
    parameters: {
      type: 'object',
      properties: {
        collections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Collection names to document (defaults to all).',
        },
      },
      required: [],
    },
    requiredCapabilities: ['schema:read'],
  },

  generateSeedData: {
    name: 'generateSeedData',
    description: 'Generate a seed data artifact for a collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'The collection to generate seed data for.',
        },
        count: {
          type: 'integer',
          description: 'Number of sample records to generate (1–20, default: 3).',
        },
      },
      required: ['collection'],
    },
    requiredCapabilities: ['items:write'],
  },

  // ── Governed surface skills (Content OS) ───────────────────────────────────
  // Mirrors the service-wired registry in apps/cms/src/services/ai-harness.ts.
  // Writes/deletes here are HITL/autonomy-gated by the harness.

  listRelations: {
    name: 'listRelations',
    description: 'List all relations configured in the schema.',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredCapabilities: ['schema:read'],
  },

  createRelation: {
    name: 'createRelation',
    description: 'Create a relation between two collections (m2o, o2m, m2m, m2a).',
    parameters: {
      type: 'object',
      properties: {
        manyCollection: { type: 'string', description: 'Collection holding the foreign key.' },
        manyField: { type: 'string', description: 'Field on manyCollection storing the relation.' },
        oneCollection: { type: 'string', description: 'Related collection.' },
        type: { type: 'string', enum: ['m2o', 'o2m', 'm2m', 'm2a'] },
      },
      required: ['manyCollection', 'manyField', 'oneCollection'],
    },
    requiredCapabilities: ['schema:create'],
  },

  deleteRelation: {
    name: 'deleteRelation',
    description: 'Delete a relation by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Relation id.' } },
      required: ['id'],
    },
    requiredCapabilities: ['schema:delete'],
  },

  listRoles: {
    name: 'listRoles',
    description: 'List RBAC roles for the current site.',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredCapabilities: ['access:read'],
  },

  createRole: {
    name: 'createRole',
    description: 'Create a new RBAC role.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name.' },
        key: { type: 'string', description: 'Optional stable key.' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
    requiredCapabilities: ['access:create'],
  },

  deleteRole: {
    name: 'deleteRole',
    description: 'Delete an RBAC role and its bindings.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Role id.' } },
      required: ['id'],
    },
    requiredCapabilities: ['access:delete'],
  },

  listPolicies: {
    name: 'listPolicies',
    description: 'List reusable access policies for the current site.',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredCapabilities: ['access:read'],
  },

  createPolicy: {
    name: 'createPolicy',
    description: 'Create a new reusable access policy.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name.' },
        key: { type: 'string', description: 'Optional stable key.' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
    requiredCapabilities: ['access:create'],
  },

  deletePolicy: {
    name: 'deletePolicy',
    description: 'Delete a reusable access policy.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Policy id.' } },
      required: ['id'],
    },
    requiredCapabilities: ['access:delete'],
  },

  listIntents: {
    name: 'listIntents',
    description: 'List content intents (SLOs) for the current site.',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredCapabilities: ['intents:read'],
  },

  createIntent: {
    name: 'createIntent',
    description: 'Create a content intent (declarative SLO) for a collection.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        collection: { type: 'string' },
        rules: { type: 'array', items: { type: 'object' }, description: 'SLO rules.' },
        schedule: { type: 'string', description: '5-field cron expression.' },
      },
      required: ['name', 'collection', 'rules', 'schedule'],
    },
    requiredCapabilities: ['intents:write'],
  },

  deleteIntent: {
    name: 'deleteIntent',
    description: 'Delete a content intent by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Intent id.' } },
      required: ['id'],
    },
    requiredCapabilities: ['intents:write'],
  },

  listFlows: {
    name: 'listFlows',
    description: 'List automation flows for the current site.',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredCapabilities: ['flows:read'],
  },

  createFlow: {
    name: 'createFlow',
    description: 'Create an automation flow (trigger + operation graph).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        triggerType: { type: 'string', enum: ['webhook', 'event', 'schedule', 'manual'] },
        graph: { type: 'object', description: 'Operation graph { entry?, nodes[] }.' },
      },
      required: ['name', 'triggerType', 'graph'],
    },
    requiredCapabilities: ['flows:write'],
  },

  deleteFlow: {
    name: 'deleteFlow',
    description: 'Delete an automation flow by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Flow id.' } },
      required: ['id'],
    },
    requiredCapabilities: ['flows:write'],
  },

  runFlow: {
    name: 'runFlow',
    description: 'Trigger a manual run of an automation flow.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Flow id.' },
        input: { type: 'object', description: 'Initial context passed to the flow.' },
      },
      required: ['id'],
    },
    requiredCapabilities: ['flows:run'],
  },
};
