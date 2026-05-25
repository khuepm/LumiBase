export * from './types';
export { CORE_SKILLS } from './skills';

import { CORE_SKILLS } from './skills';

/**
 * Returns OpenAI-compatible function calling tool representation
 * of all registered core skills.
 */
export function getAISkillsAsTools() {
  return Object.values(CORE_SKILLS).map((skill) => ({
    type: 'function',
    function: {
      name: skill.name,
      description: skill.description,
      parameters: skill.parameters,
    },
  }));
}
