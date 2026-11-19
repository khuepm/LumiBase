// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import axe from 'axe-core';
import { richTextToHtml, type RichTextBlock, type RichTextDocument } from '@lumibase/contracts/richtext';
import { registerRichTextPlugin } from '@lumibase/extension-sdk';
import RichTextEditor, { buildExtensions, slashQueryAt } from '../rich-text-editor';
import { editorJsonToRichText, richTextToEditorJson, type PmNode } from '../convert';

vi.mock('@/modules/files/media-picker', () => ({ useMediaPicker: () => undefined }));

const p = (text: string): RichTextBlock => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: RichTextBlock[]): RichTextDocument => ({ type: 'doc', version: 1, content });

const editors: Editor[] = [];
afterEach(() => {
  cleanup();
  for (const e of editors.splice(0)) e.destroy();
});

function headless(value: RichTextDocument, options = {}) {
  const editor = new Editor({ extensions: buildExtensions(options), content: richTextToEditorJson(value) });
  editors.push(editor);
  return editor;
}

/** Press a key through the editor's keymaps, as a real keydown would. */
function press(editor: Editor, key: string, mods: { shift?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', { key, shiftKey: !!mods.shift, bubbles: true, cancelable: true });
  editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));
}

/** Put the caret at the end of the first text node containing `text`. */
function caretAfter(editor: Editor, text: string) {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (pos === -1 && node.isText && node.text?.includes(text)) pos = at + node.text.indexOf(text) + text.length;
  });
  if (pos === -1) throw new Error(`text not found: ${text}`);
  editor.commands.setTextSelection(pos);
}

const read = (editor: Editor) => editorJsonToRichText(editor.getJSON() as PmNode).content;

describe('lists and Enter (Tina #7096 class of bugs)', () => {
  const list = doc({ type: 'list', ordered: false, items: [[p('one')], [p('two')]] });

  it('Enter at the end of an item starts a new item', () => {
    const e = headless(list);
    caretAfter(e, 'two');
    press(e, 'Enter');
    e.commands.insertContent('three');
    expect(read(e)).toEqual([{ type: 'list', ordered: false, items: [[p('one')], [p('two')], [p('three')]] }]);
  });

  it('Enter in the middle of an item splits it into two items', () => {
    const e = headless(doc({ type: 'list', ordered: true, items: [[p('onetwo')]] }));
    caretAfter(e, 'one');
    press(e, 'Enter');
    expect(read(e)).toEqual([{ type: 'list', ordered: true, items: [[p('one')], [p('two')]] }]);
  });

  it('Enter on an empty last item leaves the list instead of adding blank items', () => {
    const e = headless(list);
    caretAfter(e, 'two');
    press(e, 'Enter');
    press(e, 'Enter');
    e.commands.insertContent('after');
    expect(read(e)).toEqual([{ type: 'list', ordered: false, items: [[p('one')], [p('two')]] }, p('after')]);
  });

  it('Tab nests an item, Shift-Tab and Enter on an empty nested item outdent it', () => {
    const e = headless(list);
    caretAfter(e, 'two');
    press(e, 'Tab');
    expect(read(e)).toEqual([{ type: 'list', ordered: false, items: [[p('one'), { type: 'list', ordered: false, items: [[p('two')]] }]] }]);
    press(e, 'Tab', { shift: true });
    expect(read(e)).toEqual(list.content);
    press(e, 'Tab');
    press(e, 'Enter');
    press(e, 'Enter'); // empty nested item → back to the outer list
    e.commands.insertContent('outer');
    expect(read(e)).toEqual([{ type: 'list', ordered: false, items: [[p('one'), { type: 'list', ordered: false, items: [[p('two')]] }], [p('outer')]] }]);
  });

  it('Backspace at the start of an item lifts it out of the list', () => {
    const e = headless(list);
    caretAfter(e, 'two');
    e.commands.setTextSelection(e.state.selection.from - 3);
    press(e, 'Backspace');
    expect(read(e)).toEqual([{ type: 'list', ordered: false, items: [[p('one')]] }, p('two')]);
  });

  it('Enter inside a code block inserts a newline, Shift-Enter in text a hard break', () => {
    const code = headless(doc({ type: 'code', text: 'a' }));
    caretAfter(code, 'a');
    press(code, 'Enter');
    code.commands.insertContent('b');
    expect(read(code)).toEqual([{ type: 'code', text: 'a\nb' }]);

    const text = headless(doc(p('x')));
    caretAfter(text, 'x');
    press(text, 'Enter', { shift: true });
    text.commands.insertContent('y');
    expect(read(text)).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'x' }, { type: 'break' }, { type: 'text', text: 'y' }] }]);
  });
});

describe('field options shape the editor schema', () => {
  it('drops disallowed nodes and marks entirely', () => {
    const e = headless(doc(p('x')), { blocks: [], marks: ['bold'] });
    expect(e.schema.nodes.bulletList).toBeUndefined();
    expect(e.schema.nodes.table).toBeUndefined();
    expect(e.schema.nodes.heading).toBeUndefined();
    expect(e.schema.marks.italic).toBeUndefined();
    expect(e.schema.marks.bold).toBeDefined();
  });

  it('limits heading levels', () => {
    const e = headless(doc(p('x')), { headingLevels: [2, 3] });
    caretAfter(e, 'x');
    expect(e.commands.setHeading({ level: 1 })).toBe(false);
    expect(e.commands.setHeading({ level: 2 })).toBe(true);
  });
});

function editorOf(container: HTMLElement): Editor {
  const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  if (!dom?.editor) throw new Error('editor not mounted');
  return dom.editor;
}

describe('<RichTextEditor />', () => {
  it('emits sanitised documents on change', async () => {
    const onChange = vi.fn();
    const { container } = render(<RichTextEditor value={doc(p('hello'))} onChange={onChange} label="Body" />);
    const e = editorOf(container);
    act(() => {
      caretAfter(e, 'hello');
      e.commands.insertContent(' world');
    });
    expect(onChange).toHaveBeenLastCalledWith(doc(p('hello world')));
    act(() => {
      e.commands.clearContent(true);
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('parses pasted HTML into the model (Word / Docs markup, scripts, unsafe links)', () => {
    const onChange = vi.fn();
    const { container } = render(<RichTextEditor value={null} onChange={onChange} label="Body" />);
    const html =
      '<b style="font-weight:normal" id="docs-internal-guid-x"><p><span style="font-weight:700">Hi</span> <a href="javascript:alert(1)">there</a></p><script>alert(1)</script><ul><li>a</li></ul></b>';
    const target = container.querySelector('.ProseMirror')!;
    fireEvent.paste(target, { clipboardData: { getData: (type: string) => (type === 'text/html' ? html : '') } });
    const last = onChange.mock.calls.at(-1)?.[0] as RichTextDocument;
    expect(last.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: ['bold'] }, { type: 'text', text: ' there' }] },
      { type: 'list', ordered: false, items: [[p('a')]] },
    ]);
  });

  it('opens the slash menu, filters it and inserts with Enter', async () => {
    const onChange = vi.fn();
    const { container } = render(<RichTextEditor value={null} onChange={onChange} label="Body" />);
    const e = editorOf(container);
    act(() => {
      e.commands.insertContent('/tab');
    });
    expect(slashQueryAt(e)?.query).toBe('tab');
    const listbox = await screen.findByRole('listbox', { name: 'Insert block' });
    expect(listbox.textContent).toContain('Table');
    act(() => press(e, 'Enter'));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    const last = onChange.mock.calls.at(-1)?.[0] as RichTextDocument;
    expect(last.content[0]?.type).toBe('table');
  });

  it('offers custom blocks registered by extensions in the slash menu (#698)', async () => {
    const unregister = registerRichTextPlugin({ name: 'ext', blocks: { callout: { label: 'Callout', defaultData: { tone: 'info' } } } });
    try {
      const onChange = vi.fn();
      const { container } = render(<RichTextEditor value={null} onChange={onChange} label="Body" />);
      const e = editorOf(container);
      act(() => {
        e.commands.insertContent('/call');
      });
      expect((await screen.findByRole('listbox')).textContent).toContain('Callout');
      act(() => press(e, 'Enter'));
      const last = onChange.mock.calls.at(-1)?.[0] as RichTextDocument;
      expect(last.content.some((b) => b.type === 'custom' && b.name === 'callout')).toBe(true);
    } finally {
      unregister();
    }
  });

  it('rejects unsafe link URLs in the link panel', async () => {
    const onChange = vi.fn();
    const { container } = render(<RichTextEditor value={doc(p('x'))} onChange={onChange} label="Body" />);
    const e = editorOf(container);
    act(() => {
      e.commands.selectAll();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link (Ctrl+K)' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Only http/);
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const last = onChange.mock.calls.at(-1)?.[0] as RichTextDocument;
    expect(last.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'link', href: 'https://example.com', content: [{ type: 'text', text: 'x' }] }] });
  });

  it('edits a selected custom block\'s data as a JSON object (#697)', () => {
    const onChange = vi.fn();
    const { container } = render(<RichTextEditor value={doc({ type: 'custom', name: 'callout', data: { tone: 'info' } })} onChange={onChange} label="Body" />);
    const e = editorOf(container);
    act(() => {
      e.commands.setNodeSelection(0);
    });
    const area = screen.getByLabelText('Block data: callout (JSON)');
    fireEvent.change(area, { target: { value: '[1]' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[0]!);
    expect(screen.getByRole('alert').textContent).toMatch(/JSON object/);
    fireEvent.change(screen.getByLabelText('Block data: callout (JSON)'), { target: { value: '{"tone":"warn"}' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[0]!);
    const last = onChange.mock.calls.at(-1)?.[0] as RichTextDocument;
    expect(last.content[0]).toEqual({ type: 'custom', name: 'callout', data: { tone: 'warn' } });
  });

  it('exposes an accessible toolbar and editing area', async () => {
    const { container } = render(<RichTextEditor value={doc(p('x'))} onChange={vi.fn()} label="Body" />);
    const toolbar = screen.getByRole('toolbar', { name: 'Body formatting' });
    expect(toolbar.querySelectorAll('button[aria-label]').length).toBeGreaterThan(5);
    expect(screen.getByRole('textbox', { name: 'Body' }).getAttribute('aria-multiline')).toBe('true');
    // Arrow keys move inside the toolbar.
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    buttons[0]!.focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(toolbar, { key: 'End' });
    expect(document.activeElement).toBe(buttons.at(-1));
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });
});

describe('semantic tables pass axe (#699)', () => {
  it('rendered delivery HTML has no table violations', async () => {
    const html = richTextToHtml(
      doc({
        type: 'table',
        caption: 'Plans and prices',
        headerColumn: true,
        rows: [
          { header: true, cells: [[p('Plan')], [p('Monthly')], [p('Yearly')]] },
          { cells: [[p('Free')], [p('0')], [p('0')]] },
          { cells: [[p('Pro')], [p('10')], [p('100')]] },
        ],
      }),
    );
    const host = document.createElement('main');
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      const result = await axe.run(host, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(result.violations.map((v) => v.id)).toEqual([]);
      expect(host.querySelectorAll('th[scope="col"]').length).toBe(3);
      expect(host.querySelectorAll('th[scope="row"]').length).toBe(2);
      expect(host.querySelector('caption')?.textContent).toBe('Plans and prices');
    } finally {
      host.remove();
    }
  });
});
