import { describe, expect, it } from 'vitest';
import {
  relationReferencesCollection,
  relationReferencesField,
} from '../schema-service';

const relation = {
  manyCollection: 'posts',
  manyField: 'author_id',
  oneCollection: 'authors',
  oneField: 'id',
  junctionCollection: 'post_tags',
};

describe('schema relation dependency helpers', () => {
  it('detects collection references on many, one, and junction sides', () => {
    expect(relationReferencesCollection(relation, 'posts')).toBe(true);
    expect(relationReferencesCollection(relation, 'authors')).toBe(true);
    expect(relationReferencesCollection(relation, 'post_tags')).toBe(true);
    expect(relationReferencesCollection(relation, 'comments')).toBe(false);
  });

  it('detects field references on the owning side only', () => {
    expect(relationReferencesField(relation, 'posts', 'author_id')).toBe(true);
    expect(relationReferencesField(relation, 'authors', 'id')).toBe(true);
    expect(relationReferencesField(relation, 'posts', 'id')).toBe(false);
    expect(relationReferencesField(relation, 'authors', 'author_id')).toBe(false);
  });
});
