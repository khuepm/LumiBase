import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ColorInterface } from '@/modules/content/interfaces/color';
import { RatingInterface } from '@/modules/content/interfaces/rating';
import { SelectDropdownInterface } from '@/modules/content/interfaces/select';
import { SelectRadioInterface } from '@/modules/content/interfaces/select-radio';
import { SliderInterface } from '@/modules/content/interfaces/slider';
import { TagsInterface } from '@/modules/content/interfaces/tags';
import { TextInterface, TextMultilineInterface } from '@/modules/content/interfaces/text';
import { ToggleInterface } from '@/modules/content/interfaces/toggle';
import { FieldFrame, FieldGroupFrame, makeField, useStoryValue } from '../support/fixtures';

/**
 * Field interfaces — the per-field editors the item form renders, looked up by
 * `field.interface` in `apps/studio/src/modules/content/interfaces/registry.tsx`.
 * Each story keeps the value in local state so the control is interactive,
 * and frames it with a label the way the item form does.
 */
interface Args {
  disabled: boolean;
  onChange: (value: unknown) => void;
}

const meta: Meta<Args> = {
  title: 'Studio/Field interfaces',
  parameters: { layout: 'fullscreen' },
  args: { disabled: false, onChange: fn() },
  argTypes: { disabled: { control: 'boolean' } },
};

export default meta;
type Story = StoryObj<Args>;

export const Text: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<string>('Edge-native CMS');
    return (
      <FieldFrame label="Title" note="input · maxLength 80">
        <TextInterface
          value={value}
          disabled={disabled}
          field={makeField({ name: 'title', meta: { options: { placeholder: 'Article title', maxLength: 80 } } })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldFrame>
    );
  },
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByRole('textbox', { name: /title/i });
    await userEvent.clear(input);
    await userEvent.type(input, 'Hello');
    await expect(input).toHaveValue('Hello');
    await expect(args.onChange).toHaveBeenLastCalledWith('Hello');
  },
};

export const Multiline: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<string>('A short summary that spans\nmore than one line.');
    return (
      <FieldFrame label="Summary" note="input-multiline · rows 3">
        <TextMultilineInterface
          value={value}
          disabled={disabled}
          field={makeField({ name: 'summary', interface: 'input-multiline', meta: { options: { rows: 3 } } })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldFrame>
    );
  },
};

export const Toggle: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<boolean>(false);
    return (
      <FieldFrame label="Featured" note="toggle">
        <ToggleInterface
          value={value}
          disabled={disabled}
          field={makeField({ name: 'featured', type: 'boolean', interface: 'toggle' })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldFrame>
    );
  },
  play: async ({ canvasElement, args }) => {
    const toggle = within(canvasElement).getByRole('switch', { name: /featured/i });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(args.onChange).toHaveBeenLastCalledWith(true);
  },
};

export const SelectDropdown: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<string>('draft');
    return (
      <FieldFrame label="Status" note="select-dropdown">
        <SelectDropdownInterface
          value={value}
          disabled={disabled}
          field={makeField({
            name: 'status',
            interface: 'select-dropdown',
            meta: {
              options: {
                choices: [
                  { value: 'draft', text: 'Draft' },
                  { value: 'review', text: 'In review' },
                  { value: 'published', text: 'Published' },
                ],
              },
            },
          })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldFrame>
    );
  },
  play: async ({ canvasElement, args }) => {
    const select = within(canvasElement).getByRole('combobox', { name: /status/i });
    await userEvent.selectOptions(select, 'published');
    await expect(args.onChange).toHaveBeenLastCalledWith('published');
  },
};

export const SelectRadio: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<string>('en');
    return (
      <FieldGroupFrame label="Locale">
        <SelectRadioInterface
          value={value}
          disabled={disabled}
          field={makeField({
            name: 'locale',
            interface: 'select-radio',
            meta: { options: { choices: [{ value: 'en', text: 'English' }, { value: 'vi', text: 'Tiếng Việt' }] } },
          })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldGroupFrame>
    );
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('radio', { name: 'Tiếng Việt' }));
    await expect(args.onChange).toHaveBeenLastCalledWith('vi');
  },
};

export const Rating: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<number>(3);
    return (
      <FieldGroupFrame label="Editorial score">
        <RatingInterface
          value={value}
          disabled={disabled}
          field={makeField({ name: 'score', type: 'integer', interface: 'rating', meta: { options: { max: 5 } } })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldGroupFrame>
    );
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Rate 5' }));
    await expect(args.onChange).toHaveBeenLastCalledWith(5);
    await expect(within(canvasElement).getByText('5/5')).toBeVisible();
  },
};

export const Slider: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<number>(40);
    return (
      <FieldGroupFrame label="Reading time (minutes)">
        <SliderInterface
          value={value}
          disabled={disabled}
          field={makeField({ name: 'reading_time', type: 'integer', interface: 'slider', meta: { options: { min: 0, max: 60, step: 5 } } })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldGroupFrame>
    );
  },
};

export const Color: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<string>('#6d28d9');
    return (
      <FieldGroupFrame label="Accent colour">
        <ColorInterface
          value={value}
          disabled={disabled}
          field={makeField({ name: 'accent', interface: 'color' })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldGroupFrame>
    );
  },
};

export const Tags: Story = {
  render: function Render({ disabled, onChange }) {
    const [value, setValue] = useStoryValue<string[]>(['edge', 'headless']);
    return (
      <FieldGroupFrame label="Tags (Enter or comma commits)">
        <TagsInterface
          value={value}
          disabled={disabled}
          field={makeField({ name: 'tags', type: 'json', interface: 'tags' })}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldGroupFrame>
    );
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Add to tags' }), 'cms{enter}');
    await expect(args.onChange).toHaveBeenLastCalledWith(['edge', 'headless', 'cms']);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove edge' }));
    await expect(args.onChange).toHaveBeenLastCalledWith(['headless', 'cms']);
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  render: function Render({ disabled }) {
    return (
      <div className="space-y-4">
        <FieldFrame label="Slug (locked)">
          <TextInterface value="edge-native-cms" disabled={disabled} field={makeField({ name: 'slug' })} onChange={() => {}} />
        </FieldFrame>
        <FieldFrame label="Pinned (locked)">
          <ToggleInterface value disabled={disabled} field={makeField({ name: 'pinned', interface: 'toggle' })} onChange={() => {}} />
        </FieldFrame>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('switch', { name: /pinned/i })).toBeDisabled();
  },
};
