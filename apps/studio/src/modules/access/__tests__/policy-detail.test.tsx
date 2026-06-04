// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddPermissionDialog } from '../policy-detail';
import { buildAccessCollectionGroups } from '../system-collections';

describe('AddPermissionDialog', () => {
  it('groups system collections and hides sensitive targets for non-admin principals', () => {
    render(
      <AddPermissionDialog
        collectionGroups={buildAccessCollectionGroups(['posts', 'api_keys'], false)}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        error={null}
      />,
    );

    expect(screen.getByRole('group', { name: 'Content collections' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Schema builder' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Access control' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Sensitive system' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'api_keys' })).not.toBeInTheDocument();
  });

  it('allows admins to select sensitive system collections', () => {
    const onSubmit = vi.fn();
    render(
      <AddPermissionDialog
        collectionGroups={buildAccessCollectionGroups(['posts'], true)}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        error={null}
      />,
    );

    expect(screen.getByRole('group', { name: 'Sensitive system' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/collection/i), { target: { value: 'api_keys' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onSubmit).toHaveBeenCalledWith('api_keys', 'read');
  });
});
