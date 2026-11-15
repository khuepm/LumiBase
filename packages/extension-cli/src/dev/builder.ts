import { context, type BuildContext, type Plugin } from 'esbuild';
import { isExtensionDevServerType } from '@lumibase/contracts/extensions';

/**
 * Incremental extension bundler for `lumibase-ext dev`.
 *
 * Wraps one esbuild `context()` per extension so every rebuild after the first
 * reuses esbuild's incremental state (typically a few milliseconds). Output is
 * a single self-contained ESM module kept in memory (`write: false`) — the hub
 * serves it straight from RAM.
 *
 * UI extensions must share Studio's React instance (two Reacts break hooks),
 * so `react`, `react/jsx-runtime` and `react-dom` resolve to shims that read
 * the instance Studio publishes on `globalThis.__lumibaseShared` in dev.
 */

export interface BuildResult {
  ok: boolean;
  code: string;
  durationMs: number;
  errors: string[];
}

export interface ExtensionBuilder {
  rebuild(): Promise<BuildResult>;
  dispose(): Promise<void>;
}

export interface BuilderOptions {
  entryPath: string;
  type: string;
  /** Working directory for resolution (the extension folder). */
  cwd: string;
}

/** Named exports re-exported from Studio's React by the shim. */
const REACT_EXPORTS = [
  'Children', 'Component', 'Fragment', 'PureComponent', 'StrictMode', 'Suspense',
  'cloneElement', 'createContext', 'createElement', 'createRef', 'forwardRef',
  'isValidElement', 'lazy', 'memo', 'startTransition', 'use', 'useCallback',
  'useContext', 'useDebugValue', 'useDeferredValue', 'useEffect', 'useId',
  'useImperativeHandle', 'useInsertionEffect', 'useLayoutEffect', 'useMemo',
  'useReducer', 'useRef', 'useState', 'useSyncExternalStore', 'useTransition',
  'version',
];

function shimSource(key: string, names: string[]): string {
  const lookup = `globalThis.__lumibaseShared && globalThis.__lumibaseShared[${JSON.stringify(key)}]`;
  const lines = [
    `const m = ${lookup};`,
    `if (!m) throw new Error(${JSON.stringify(`LumiBase Studio did not provide shared module "${key}"`)});`,
    'export default (m.default ?? m);',
  ];
  for (const n of names) lines.push(`export const ${n} = m[${JSON.stringify(n)}];`);
  return lines.join('\n');
}

const SHIMS: Record<string, string> = {
  react: shimSource('react', REACT_EXPORTS),
  'react/jsx-runtime': shimSource('react/jsx-runtime', ['jsx', 'jsxs', 'Fragment']),
  'react/jsx-dev-runtime': shimSource('react/jsx-runtime', ['jsx', 'jsxs', 'Fragment']),
  'react-dom': shimSource('react-dom', ['createPortal', 'flushSync']),
};

const sharedReactPlugin: Plugin = {
  name: 'lumibase-shared-react',
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/jsx-(dev-)?runtime)?$/ }, (args) => ({
      path: args.path,
      namespace: 'lumibase-shared',
    }));
    build.onLoad({ filter: /.*/, namespace: 'lumibase-shared' }, (args) => ({
      contents: SHIMS[args.path] ?? 'export default undefined;',
      loader: 'js',
    }));
  },
};

export async function createExtensionBuilder(options: BuilderOptions): Promise<ExtensionBuilder> {
  const server = isExtensionDevServerType(options.type);
  const ctx: BuildContext = await context({
    entryPoints: [options.entryPath],
    absWorkingDir: options.cwd,
    bundle: true,
    format: 'esm',
    // Server bundles run inside the CMS sandbox (Node in dev); UI bundles in the browser.
    platform: server ? 'neutral' : 'browser',
    mainFields: server ? ['module', 'main'] : ['browser', 'module', 'main'],
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: 'inline',
    write: false,
    logLevel: 'silent',
    plugins: server ? [] : [sharedReactPlugin],
  });

  return {
    async rebuild() {
      const started = performance.now();
      try {
        const result = await ctx.rebuild();
        const file = result.outputFiles?.[0];
        return {
          ok: Boolean(file),
          code: file?.text ?? '',
          durationMs: performance.now() - started,
          errors: file ? [] : ['esbuild produced no output'],
        };
      } catch (err) {
        const errors =
          err && typeof err === 'object' && 'errors' in err && Array.isArray(err.errors)
            ? (err.errors as Array<{ text?: string; location?: { file?: string; line?: number } | null }>).map(
                (e) => `${e.location?.file ?? ''}${e.location?.line ? `:${e.location.line}` : ''} ${e.text ?? ''}`.trim(),
              )
            : [err instanceof Error ? err.message : String(err)];
        return { ok: false, code: '', durationMs: performance.now() - started, errors };
      }
    },
    dispose: () => ctx.dispose(),
  };
}
