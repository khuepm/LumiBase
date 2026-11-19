import {
  RICHTEXT_LIMITS,
  RICHTEXT_MARKS,
  RICHTEXT_VERSION,
  type RichTextDocument,
} from './model';

/** Where and why a value is not a well-formed document. */
export interface RichTextIssue {
  /** Path from the document root, e.g. `['content', 2, 'items', 0, 0]`. */
  path: Array<string | number>;
  message: string;
}

export interface RichTextLimits {
  maxDepth: number;
  maxNodes: number;
  maxTextLength: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Walker {
  nodes = 0;
  text = 0;
  issue: RichTextIssue | null = null;
  constructor(private readonly limits: RichTextLimits) {}

  fail(path: Array<string | number>, message: string): false {
    this.issue ??= { path, message };
    return false;
  }

  count(path: Array<string | number>, ...strings: Array<unknown>): boolean {
    this.nodes += 1;
    for (const s of strings) if (typeof s === 'string') this.text += s.length;
    if (this.nodes > this.limits.maxNodes) return this.fail(path, `Document has more than ${this.limits.maxNodes} nodes.`);
    if (this.text > this.limits.maxTextLength) {
      return this.fail(path, `Document text is longer than ${this.limits.maxTextLength} characters.`);
    }
    return true;
  }

  ref(v: unknown, path: Array<string | number>): boolean {
    if (!isObj(v) || typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 256) {
      return this.fail(path, 'Reference needs a non-empty `id`.');
    }
    if (v.kind === 'file') {
      return v.collection === undefined || typeof v.collection === 'string' ? true : this.fail(path, 'Invalid `collection`.');
    }
    if (v.kind === 'item' && typeof v.collection === 'string' && v.collection.length > 0) return true;
    return this.fail(path, 'Reference `kind` must be `file`, or `item` with a `collection`.');
  }

  inlines(v: unknown, path: Array<string | number>, depth: number): boolean {
    if (!Array.isArray(v)) return this.fail(path, 'Expected an array of inline nodes.');
    return v.every((n, i) => this.inline(n, [...path, i], depth + 1));
  }

  blocks(v: unknown, path: Array<string | number>, depth: number): boolean {
    if (!Array.isArray(v)) return this.fail(path, 'Expected an array of blocks.');
    return v.every((n, i) => this.block(n, [...path, i], depth + 1));
  }

  inline(v: unknown, path: Array<string | number>, depth: number): boolean {
    if (depth > this.limits.maxDepth) return this.fail(path, `Nesting deeper than ${this.limits.maxDepth}.`);
    if (!isObj(v)) return this.fail(path, 'Expected an inline node object.');
    switch (v.type) {
      case 'text':
        if (typeof v.text !== 'string') return this.fail(path, '`text` must be a string.');
        if (
          v.marks !== undefined &&
          !(Array.isArray(v.marks) && v.marks.every((m) => (RICHTEXT_MARKS as readonly unknown[]).includes(m)))
        ) {
          return this.fail([...path, 'marks'], `Unknown mark; allowed: ${RICHTEXT_MARKS.join(', ')}.`);
        }
        return this.count(path, v.text);
      case 'link':
        if (typeof v.href !== 'string') return this.fail(path, '`href` must be a string.');
        return this.count(path, v.href) && this.inlines(v.content, [...path, 'content'], depth);
      case 'ref':
        return this.count(path) && this.ref(v.ref, [...path, 'ref']) && this.inlines(v.content, [...path, 'content'], depth);
      case 'embed':
        if (v.alt !== undefined && typeof v.alt !== 'string') return this.fail(path, '`alt` must be a string.');
        return this.count(path, v.alt) && this.ref(v.ref, [...path, 'ref']);
      case 'break':
        return this.count(path);
      case 'footnote':
        if (typeof v.label !== 'string' || v.label.length === 0) return this.fail(path, 'Footnote needs a `label`.');
        return this.count(path, v.label);
      default:
        return this.fail(path, `Unknown inline node type ${JSON.stringify(v.type)}.`);
    }
  }

  block(v: unknown, path: Array<string | number>, depth: number): boolean {
    if (depth > this.limits.maxDepth) return this.fail(path, `Nesting deeper than ${this.limits.maxDepth}.`);
    if (!isObj(v)) return this.fail(path, 'Expected a block object.');
    switch (v.type) {
      case 'paragraph':
        return this.count(path) && this.inlines(v.content, [...path, 'content'], depth);
      case 'heading':
        if (typeof v.level !== 'number' || ![1, 2, 3, 4, 5, 6].includes(v.level)) {
          return this.fail([...path, 'level'], 'Heading `level` must be 1–6.');
        }
        return this.count(path) && this.inlines(v.content, [...path, 'content'], depth);
      case 'quote':
        return this.count(path) && this.blocks(v.content, [...path, 'content'], depth);
      case 'list':
        if (typeof v.ordered !== 'boolean') return this.fail(path, 'List needs a boolean `ordered`.');
        if (v.start !== undefined && !(Number.isInteger(v.start) && (v.start as number) >= 0)) {
          return this.fail([...path, 'start'], '`start` must be a non-negative integer.');
        }
        if (!Array.isArray(v.items)) return this.fail(path, 'List needs `items`.');
        return this.count(path) && v.items.every((item, i) => this.blocks(item, [...path, 'items', i], depth));
      case 'code':
        if (typeof v.text !== 'string') return this.fail(path, 'Code block needs `text`.');
        if (v.language !== undefined && typeof v.language !== 'string') return this.fail(path, '`language` must be a string.');
        return this.count(path, v.text, v.language);
      case 'rule':
        return this.count(path);
      case 'embed':
        if (v.alt !== undefined && typeof v.alt !== 'string') return this.fail(path, '`alt` must be a string.');
        return this.count(path, v.alt) && this.ref(v.ref, [...path, 'ref']);
      case 'table': {
        if (!Array.isArray(v.rows)) return this.fail(path, 'Table needs `rows`.');
        if (v.caption !== undefined && typeof v.caption !== 'string') return this.fail(path, '`caption` must be a string.');
        if (v.headerColumn !== undefined && typeof v.headerColumn !== 'boolean') {
          return this.fail(path, '`headerColumn` must be a boolean.');
        }
        if (
          v.align !== undefined &&
          !(Array.isArray(v.align) && v.align.every((a) => a === null || a === 'left' || a === 'center' || a === 'right'))
        ) {
          return this.fail([...path, 'align'], '`align` entries must be left, center, right or null.');
        }
        if (!this.count(path, v.caption)) return false;
        return v.rows.every((r, i) => {
          const rp = [...path, 'rows', i];
          if (!isObj(r) || !Array.isArray(r.cells)) return this.fail(rp, 'Table row needs `cells`.');
          if (r.header !== undefined && typeof r.header !== 'boolean') return this.fail(rp, '`header` must be a boolean.');
          return this.count(rp) && r.cells.every((c, j) => this.blocks(c, [...rp, 'cells', j], depth));
        });
      }
      case 'footnote':
        if (typeof v.label !== 'string' || v.label.length === 0) return this.fail(path, 'Footnote needs a `label`.');
        return this.count(path, v.label) && this.blocks(v.content, [...path, 'content'], depth);
      case 'custom':
        if (typeof v.name !== 'string' || v.name.length === 0) return this.fail(path, 'Custom block needs a `name`.');
        if (!isObj(v.data)) return this.fail([...path, 'data'], 'Custom block `data` must be an object.');
        return this.count(path, v.name, safeJsonLength(v.data));
      default:
        return this.fail(path, `Unknown block type ${JSON.stringify(v.type)}.`);
    }
  }
}

function safeJsonLength(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Full structural check with limits: the first problem found, or `null` when
 * `value` is a well-formed v1 document within {@link RICHTEXT_LIMITS}.
 */
export function validateRichTextDocument(
  value: unknown,
  limits: RichTextLimits = RICHTEXT_LIMITS,
): RichTextIssue | null {
  if (!isObj(value) || value.type !== 'doc') return { path: [], message: 'Expected `{ type: "doc", version: 1, content: [...] }`.' };
  if (value.version !== RICHTEXT_VERSION) return { path: ['version'], message: `Unsupported version; expected ${RICHTEXT_VERSION}.` };
  const w = new Walker(limits);
  w.blocks(value.content, ['content'], -1);
  return w.issue;
}

/** Structural check: is `value` a well-formed v1 document? */
export function isRichTextDocument(value: unknown): value is RichTextDocument {
  return validateRichTextDocument(value) === null;
}
