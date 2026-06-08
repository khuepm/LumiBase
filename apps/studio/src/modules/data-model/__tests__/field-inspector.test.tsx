// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldInspector, type FieldFormState } from '../field-inspector';

const baseState: FieldFormState = {
  name: 'title',
  type: 'string',
  interface: 'input',
  label: 'Title',
  note: 'Editorial title',
  defaultValue: 'Untitled',
  nullable: false,
  unique: true,
  indexed: true,
  searchable: true,
  length: 160,
  precision: null,
  scale: null,
  special: ['cast-string'],
  options: { trim: true, nested: { preserved: 'yes' } },
  required: true,
  readonly: false,
  hidden: false,
  encrypted: false,
  versioned: true,
  rawEnabled: true,
  group: 'content',
  width: 'full',
  sortOrder: 2,
  display: 'mustache',
  displayOptions: { template: '{{ title }}', unknownDisplayOption: 'keep-me' },
  validation: { rules: [{ _contains: 'news' }], unknownValidation: true },
  conditions: [{ name: 'readonly-archived', rule: { status: { _eq: 'archived' } } }],
  translations: { vi: { label: 'Tieu de' } },
};

afterEach(() => cleanup());

describe('FieldInspector', () => {
  it('renders advanced tabs and preserves unknown JSON config on submit', () => {
    const onSubmit = vi.fn();

    render(
      <FieldInspector
        state={baseState}
        siblingFields={[{ name: 'status', type: 'string', interface: 'select-dropdown' }]}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    for (const tab of ['Basics', 'Options', 'Display', 'Validation', 'Conditions', 'Layout', 'Storage', 'Translations']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: /^options$/i }));
    expect((screen.getByLabelText(/options json/i) as HTMLTextAreaElement).value).toContain(
      '"preserved": "yes"',
    );

    fireEvent.click(screen.getByRole('button', { name: /^display$/i }));
    expect((screen.getByLabelText(/display options json/i) as HTMLTextAreaElement).value).toContain(
      '"unknownDisplayOption": "keep-me"',
    );

    fireEvent.click(screen.getByRole('button', { name: /^validation$/i }));
    expect((screen.getByLabelText(/validation json/i) as HTMLTextAreaElement).value).toContain(
      '"unknownValidation": true',
    );

    fireEvent.click(screen.getByRole('button', { name: /^conditions$/i }));
    expect((screen.getByLabelText(/conditions json/i) as HTMLTextAreaElement).value).toContain(
      '"readonly-archived"',
    );

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { trim: true, nested: { preserved: 'yes' } },
        displayOptions: { template: '{{ title }}', unknownDisplayOption: 'keep-me' },
        validation: { rules: [{ _contains: 'news' }], unknownValidation: true },
        conditions: [{ name: 'readonly-archived', rule: { status: { _eq: 'archived' } } }],
        translations: { vi: { label: 'Tieu de' } },
      }),
    );
  });

  it('applies catalogue defaults when selecting a relation interface', () => {
    const onSubmit = vi.fn();

    render(
      <FieldInspector
        state={{ ...baseState, options: {}, special: [], display: null }}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    fireEvent.change(screen.getByLabelText(/interface/i), { target: { value: 'relation-m2m' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        interface: 'relation-m2m',
        type: 'alias',
        display: 'relation',
        options: expect.objectContaining({ collection: '', junctionCollection: '' }),
        special: ['m2m'],
      }),
    );
  });

  it('applies SEO extension defaults from the catalogue', () => {
    const onSubmit = vi.fn();

    render(
      <FieldInspector
        state={{ ...baseState, options: {}, special: [], display: null }}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    fireEvent.change(screen.getByLabelText(/interface/i), { target: { value: 'seo' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        interface: 'seo',
        type: 'json',
        options: expect.objectContaining({
          titleMaxLength: 70,
          descriptionMaxLength: 160,
        }),
        special: [],
        width: 'full',
      }),
    );
  });

  it('applies AIO extension defaults from the catalogue', () => {
    const onSubmit = vi.fn();

    render(
      <FieldInspector
        state={{ ...baseState, options: {}, special: [], display: null }}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    fireEvent.change(screen.getByLabelText(/interface/i), { target: { value: 'aio' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        interface: 'aio',
        type: 'json',
        options: expect.objectContaining({
          summaryMaxLength: 300,
          tones: ['neutral', 'expert', 'friendly'],
        }),
        special: [],
        width: 'full',
      }),
    );
  });
});
