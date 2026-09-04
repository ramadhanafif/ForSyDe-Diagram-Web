import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

describe('versioning', () => {
  it('package.json version is valid semver', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/);
  });
});
