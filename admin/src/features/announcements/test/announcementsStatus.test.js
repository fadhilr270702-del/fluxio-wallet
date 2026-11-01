import { describe, it, expect } from 'vitest';
import { targetPlatformLabel, TARGET_OPTIONS } from '../announcementsStatus.js';

describe('targetPlatformLabel — the four known values', () => {
  it('labels "all" as "All platforms"', () => {
    expect(targetPlatformLabel('all')).toBe('All platforms');
  });

  it('labels "extension" as "Browser extension"', () => {
    expect(targetPlatformLabel('extension')).toBe('Browser extension');
  });

  it('labels "mobile" as "Mobile app"', () => {
    expect(targetPlatformLabel('mobile')).toBe('Mobile app');
  });

  it('labels "web" as "Web app"', () => {
    expect(targetPlatformLabel('web')).toBe('Web app');
  });
});

describe('targetPlatformLabel — unrecognized value falls back to the raw code', () => {
  it('returns the code itself for a value with no known label, rather than throwing or returning blank', () => {
    expect(targetPlatformLabel('desktop')).toBe('desktop');
  });
});

describe('TARGET_OPTIONS — the form dropdown\'s own order (user\'s explicit choice)', () => {
  it('is exactly [all, extension, mobile, web], in that order', () => {
    expect(TARGET_OPTIONS).toEqual(['all', 'extension', 'mobile', 'web']);
  });
});
