import { describe, it, expect } from 'vitest';
import { validateProjectName } from './validate.js';

describe('validateProjectName', () => {
  it('accepts a simple valid name', () => {
    expect(validateProjectName('my-blog')).toBeUndefined();
  });

  it('accepts scoped names', () => {
    expect(validateProjectName('@acme/cms')).toBeUndefined();
  });

  it('rejects empty / whitespace names', () => {
    expect(validateProjectName('')).toMatch(/empty/i);
    expect(validateProjectName('   ')).toMatch(/empty/i);
  });

  it('rejects uppercase letters', () => {
    expect(validateProjectName('MyBlog')).toMatch(/lowercase/i);
  });

  it('rejects illegal characters', () => {
    expect(validateProjectName('my blog')).toMatch(/may only contain/i);
    expect(validateProjectName('my!blog')).toMatch(/may only contain/i);
  });

  it('rejects names starting with a dot or underscore', () => {
    expect(validateProjectName('.hidden')).toMatch(/cannot start/i);
    expect(validateProjectName('_private')).toMatch(/cannot start/i);
  });

  it('rejects names longer than 214 characters', () => {
    expect(validateProjectName('a'.repeat(215))).toMatch(/214/);
  });
});
