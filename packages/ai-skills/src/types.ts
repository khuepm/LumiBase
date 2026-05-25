export interface AISkillParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: Record<string, any>;
  properties?: Record<string, any>;
  required?: string[];
}

export interface AISkillDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, AISkillParameter>;
    required: string[];
  };
  requiredCapabilities: string[];
}
