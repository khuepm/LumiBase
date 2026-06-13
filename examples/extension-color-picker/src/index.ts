import ColorPickerInterface from './interface';
import { defineInterface } from '@lumibase/extension-sdk';

// 1. Export the extension manifest
export const manifest = {
  id: 'lumibase/color-picker',
  name: 'Color Picker',
  version: '1.0.0',
  type: 'interface',
  icon: 'palette',
  description: 'A premium visual color picker field interface.',
  author: {
    name: 'LumiBase Team',
    email: 'hello@lumibase.dev',
  },
  requiredCapabilities: [],
  compatibleWith: '^0.4.0',
};

// 2. Export the interface definition.
// At runtime, LumiBase Studio imports this default export and registers the component.
export default defineInterface({
  id: 'color-picker',
  name: 'Color Picker',
  component: ColorPickerInterface,
  types: ['string'], // compatible with string field types in Postgres
  group: 'standard',
  options: [
    {
      field: 'defaultColor',
      name: 'Default Hex Color',
      type: 'string',
      meta: {
        interface: 'input',
        options: {
          placeholder: '#FFFFFF',
        },
      },
    },
  ],
});
