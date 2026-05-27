import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useLocale } from '../useLocale';

// Mock react-router-dom's useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const STORAGE_KEY = 'lumibase-docs:locale';

function createLocalStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
}

describe('useLocale', () => {
  let mockStorage: ReturnType<typeof createLocalStorageMock>;

  beforeEach(() => {
    mockStorage = createLocalStorageMock();
    Object.defineProperty(window, 'localStorage', {
      value: mockStorage,
      writable: true,
    });
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Render useLocale inside a MemoryRouter with Routes that match
   * the :locale param pattern used in the real app router.
   */
  function renderUseLocale(initialPath: string) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/:locale/docs/*', element: children }),
          createElement(Route, { path: '/:locale', element: children }),
          createElement(Route, { path: '*', element: children })
        )
      );

    return renderHook(() => useLocale(), { wrapper });
  }

  describe('reading locale from URL', () => {
    it('returns the correct locale when URL has a valid locale prefix', () => {
      const { result } = renderUseLocale('/en/docs/README');
      expect(result.current.locale).toBe('en');
    });

    it('returns vi locale when URL has /vi/ prefix', () => {
      const { result } = renderUseLocale('/vi/docs/features/ai-copilot');
      expect(result.current.locale).toBe('vi');
    });

    it('returns defaultLocale when URL has no locale prefix', () => {
      const { result } = renderUseLocale('/docs/README');
      expect(result.current.locale).toBe('en');
    });

    it('returns defaultLocale when URL has an invalid locale prefix', () => {
      const { result } = renderUseLocale('/zz/docs/anything');
      expect(result.current.locale).toBe('en');
    });

    it('returns defaultLocale for root path', () => {
      const { result } = renderUseLocale('/');
      expect(result.current.locale).toBe('en');
    });
  });

  describe('exposed values', () => {
    it('exposes defaultLocale as "en"', () => {
      const { result } = renderUseLocale('/en/docs/README');
      expect(result.current.defaultLocale).toBe('en');
    });

    it('exposes locales array', () => {
      const { result } = renderUseLocale('/en/docs/README');
      expect(result.current.locales).toEqual(['en', 'vi']);
    });
  });

  describe('setLocale navigation', () => {
    it('navigates to the correct path when switching locale with a slug', () => {
      const { result } = renderUseLocale('/en/docs/features/ai-copilot');

      act(() => {
        result.current.setLocale('vi', 'features/ai-copilot');
      });

      expect(mockNavigate).toHaveBeenCalledWith('/vi/docs/features/ai-copilot');
    });

    it('navigates using current slug when no slug is provided', () => {
      const { result } = renderUseLocale('/en/docs/features/ai-copilot');

      act(() => {
        result.current.setLocale('vi');
      });

      expect(mockNavigate).toHaveBeenCalledWith('/vi/docs/features/ai-copilot');
    });

    it('navigates to README when no slug is provided and no current slug exists', () => {
      const { result } = renderUseLocale('/en');

      act(() => {
        result.current.setLocale('vi');
      });

      expect(mockNavigate).toHaveBeenCalledWith('/vi/docs/README');
    });
  });

  describe('localStorage persistence', () => {
    it('persists locale choice to localStorage on setLocale', () => {
      const { result } = renderUseLocale('/en/docs/README');

      act(() => {
        result.current.setLocale('vi', 'README');
      });

      expect(mockStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, 'vi');
    });

    it('gracefully handles localStorage.setItem throwing', () => {
      mockStorage.setItem.mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      const { result } = renderUseLocale('/en/docs/README');

      expect(() => {
        act(() => {
          result.current.setLocale('vi', 'README');
        });
      }).not.toThrow();

      // Navigation should still happen even if storage fails
      expect(mockNavigate).toHaveBeenCalledWith('/vi/docs/README');
    });
  });
});
