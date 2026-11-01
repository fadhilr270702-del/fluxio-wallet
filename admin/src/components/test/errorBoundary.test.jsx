// @vitest-environment jsdom
/**
 * Prompt 0192 — unit tests for the content-area ErrorBoundary. This is
 * admin's first component test (every earlier admin test is a pure-helper
 * suite), hence the first use of @testing-library/react + jsdom here —
 * the jsdom environment is opted into per-file via the pragma above so
 * every existing 'node'-environment test keeps running exactly as before.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ErrorBoundary from '../ErrorBoundary.jsx';

let bombShouldThrow = true;
function Bomb() {
  if (bombShouldThrow) throw new Error('summary is malformed');
  return <div data-testid="healthy-child">healthy content</div>;
}

function Shell({ resetKey }) {
  return (
    <div>
      <aside data-testid="dummy-sidebar">sidebar outside the boundary</aside>
      <ErrorBoundary resetKey={resetKey}>
        <Bomb />
      </ErrorBoundary>
    </div>
  );
}

beforeEach(() => {
  bombShouldThrow = true;
  vi.restoreAllMocks();
});

// RTL's auto-cleanup only registers itself when a global afterEach exists
// (vitest here runs without `globals: true`), so clean up explicitly or
// each test's DOM piles onto the last one's.
afterEach(() => {
  cleanup();
});

describe('ErrorBoundary (prompt 0192)', () => {
  it('a child throwing during render shows the fallback card while siblings outside the boundary stay mounted', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Shell resetKey="/dashboard" />);
    expect(screen.getByText('This page failed to load')).toBeTruthy();
    expect(screen.getByText('summary is malformed')).toBeTruthy();
    expect(screen.getByTestId('dummy-sidebar')).toBeTruthy();
    expect(screen.queryByTestId('healthy-child')).toBeNull();
    // componentDidCatch logged with the contract prefix + route name
    const boundaryLogs = consoleError.mock.calls.filter((c) => c[0] === '[admin] content error boundary:');
    expect(boundaryLogs.length).toBe(1);
    expect(boundaryLogs[0][1]).toBe('/dashboard');
  });

  it('"Try again" re-renders the children once they stop throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Shell resetKey="/dashboard" />);
    expect(screen.getByText('This page failed to load')).toBeTruthy();
    bombShouldThrow = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
    expect(screen.queryByText('This page failed to load')).toBeNull();
  });

  it('a resetKey change (route navigation) clears the caught error on its own', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<Shell resetKey="/dashboard" />);
    expect(screen.getByText('This page failed to load')).toBeTruthy();
    bombShouldThrow = false;
    rerender(<Shell resetKey="/announcements" />);
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
    expect(screen.queryByText('This page failed to load')).toBeNull();
  });

  it('a healthy child renders untouched and console.error is never called', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bombShouldThrow = false;
    render(<Shell resetKey="/dashboard" />);
    expect(screen.getByTestId('healthy-child')).toBeTruthy();
    expect(screen.queryByText('This page failed to load')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
