import type { FigmaNode } from '../client';

/** Shaped like `GET /v1/files/:key/nodes` → `nodes[id].document` for a hero card. */
export const HERO_FRAME: FigmaNode = {
  id: '12:34',
  name: 'Hero Card',
  type: 'FRAME',
  cornerRadius: 12,
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
  children: [
    { id: '12:35', name: 'Background', type: 'RECTANGLE', fills: [{ type: 'IMAGE', imageRef: 'abc' }] },
    {
      id: '12:36',
      name: 'Title',
      type: 'TEXT',
      characters: 'Ship content faster',
      style: { fontFamily: 'Inter', fontSize: 40, fontWeight: 700 },
      fills: [{ type: 'SOLID', color: { r: 0.0588, g: 0.0902, b: 0.1647, a: 1 } }],
    },
    {
      id: '12:37',
      name: 'Body copy',
      type: 'TEXT',
      characters: 'LumiBase is a Content OS: governed agents operate your content against declarative SLOs, with full provenance.',
      style: { fontFamily: 'Inter', fontSize: 16 },
      fills: [{ type: 'SOLID', color: { r: 0.0588, g: 0.0902, b: 0.1647, a: 1 } }],
    },
    { id: '12:38', name: 'Hidden note', type: 'TEXT', visible: false, characters: 'internal' },
    {
      id: '12:39',
      name: 'Button / Primary',
      type: 'FRAME',
      cornerRadius: 12,
      fills: [{ type: 'SOLID', color: { r: 0.3098, g: 0.2745, b: 0.898, a: 1 } }],
      children: [
        {
          id: '12:40',
          name: 'Label',
          type: 'TEXT',
          characters: 'Get started',
          style: { fontFamily: 'Inter', fontSize: 16 },
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
        },
      ],
    },
  ],
};

/** The same card where the designer named the fields explicitly. */
export const EXPLICIT_FRAME: FigmaNode = {
  id: '20:1',
  name: 'Quote',
  type: 'COMPONENT',
  children: [
    { id: '20:2', name: '#quote', type: 'TEXT', characters: 'Great tool.' },
    { id: '20:3', name: 'decoration', type: 'TEXT', characters: '"' },
    { id: '20:4', name: '#author', type: 'TEXT', characters: 'Linh' },
    { id: '20:5', name: '#avatar', type: 'ELLIPSE', fills: [{ type: 'IMAGE', imageRef: 'x' }] },
  ],
};

export function nodesResponse(node: FigmaNode) {
  return { name: 'Design file', nodes: { [node.id]: { document: node, components: {}, styles: {} } } };
}
