import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The five linear stages of the Admin Setup Wizard, in order. The state
 * machine is described in design.md §5.4 and the route layout in §5.1.
 */
export const SETUP_STEPS = ['account', 'path', 'security', 'project', 'recovery', 'done'] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

interface StepDescriptor {
  id: SetupStep;
  /** URL path for this step under the public layout. */
  path: SetupStepPath;
  /** Short label rendered in the progress indicator. */
  label: string;
  /** Long description for the active step (rendered as subtitle). */
  description: string;
}

type SetupStepPath =
  | '/setup/advance'
  | '/setup/path'
  | '/setup/security'
  | '/setup/project'
  | '/setup/recovery'
  | '/setup/done';

const STEP_TABLE: ReadonlyArray<StepDescriptor> = [
  {
    id: 'account',
    path: '/setup/advance',
    label: 'Account',
    description: 'Create the first administrator account.',
  },
  {
    id: 'path',
    path: '/setup/path',
    label: 'Path',
    description: 'Pick a private URL for the Studio admin surface.',
  },
  {
    id: 'security',
    path: '/setup/security',
    label: 'Security',
    description: 'Configure login lockout and anomaly detection.',
  },
  {
    id: 'project',
    path: '/setup/project',
    label: 'Project',
    description: 'Set language, site URL, title, and theme direction.',
  },
  {
    id: 'recovery',
    path: '/setup/recovery',
    label: 'Recovery',
    description: 'Save backup codes for emergency access.',
  },
  {
    id: 'done',
    path: '/setup/done',
    label: 'Done',
    description: 'Setup complete — bookmark your admin URL.',
  },
];

/**
 * Resolve the current step from a router pathname. Anything unknown collapses
 * to `'account'` (the entry step) so the indicator never renders blank.
 */
export function resolveSetupStep(pathname: string): SetupStep {
  const normalized = pathname.replace(/\/+$/, '').toLowerCase();
  for (const step of STEP_TABLE) {
    if (normalized === step.path || normalized.startsWith(`${step.path}/`)) {
      return step.id;
    }
  }
  return 'account';
}

interface SetupLayoutProps {
  children: ReactNode;
  /**
   * Override the active step explicitly. Useful for tests or for step pages
   * that want to force a particular highlight; defaults to the value derived
   * from the current router pathname.
   */
  activeStep?: SetupStep;
}

/**
 * BareLayout-style shell for the first-time Setup Wizard.
 *
 * Renders the chrome around an active step:
 *  - centered card with neutral background (no Studio AppShell, no sidebar);
 *  - five-step progress indicator (Account → Path → Security → Recovery → Done);
 *  - subtitle describing the current step.
 *
 * The actual step body is supplied via `children` (in production this is the
 * router `<Outlet />`). `SetupLayout` does not call any backend; the
 * `state='initialized'` / token / network gating is the responsibility of
 * `SetupStateGate`, which wraps `SetupLayout` from the outside so failure
 * screens never leak the progress chrome.
 *
 * Spec refs: Req 2.5 (no AppShell), design §5.1 (BareLayout), §5.4 (steps).
 */
export function SetupLayout({ children, activeStep }: SetupLayoutProps) {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const current = activeStep ?? resolveSetupStep(location.pathname);
  const currentDescriptor = STEP_TABLE.find((s) => s.id === current) ?? STEP_TABLE[0]!;

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <header className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase text-primary">
                Advanced setup
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                Set up LumiBase with full controls
              </h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Use the full wizard when you want to tune admin path,
                security policy, project identity, and recovery settings one
                screen at a time.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate({ to: '/setup/account' })}
              className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted"
            >
              Quick setup
            </button>
          </div>
          <p className="text-sm text-muted-foreground">
            {currentDescriptor.description}
          </p>
        </header>

        <ProgressIndicator current={current} />

        <main
          className="rounded-md border bg-background p-5 shadow-sm sm:p-6"
          role="main"
          aria-labelledby="setup-step-heading"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

interface ProgressIndicatorProps {
  current: SetupStep;
}

/**
 * Five-step progress indicator. Steps before `current` render as completed
 * (filled circle + check icon), the active step is highlighted, later steps
 * render as muted placeholders. Connector segments fill proportionally so
 * users can read progress at a glance.
 */
function ProgressIndicator({ current }: ProgressIndicatorProps) {
  const navigate = useNavigate();
  const currentIndex = STEP_TABLE.findIndex((s) => s.id === current);
  const recoveryIndex = STEP_TABLE.findIndex((s) => s.id === 'recovery');
  const allowBackNavigation = currentIndex >= 0 && currentIndex < recoveryIndex;

  return (
    <ol
      className="flex items-center"
      role="list"
      aria-label="Setup progress"
    >
      {STEP_TABLE.map((step, index) => {
        const isCompleted = index < currentIndex;
        const isActive = index === currentIndex;
        const isLast = index === STEP_TABLE.length - 1;
        const canNavigateBack = allowBackNavigation && isCompleted;
        const stepMarker = (
          <>
            <span
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full border text-xs font-medium cursor-pointer',
                isCompleted && 'border-primary bg-primary text-primary-foreground',
                isActive && 'border-primary bg-background text-primary ring-2 ring-primary/20',
                !isCompleted && !isActive && 'border-border bg-background text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
            </span>
            <span
              className={cn(
                'mt-2 text-xs cursor-pointer',
                isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
                canNavigateBack && 'text-foreground',
              )}
            >
              {step.label}
            </span>
          </>
        );

        return (
          <li
            key={step.id}
            className={cn('flex items-center', isLast ? 'flex-none' : 'flex-1')}
            aria-current={isActive ? 'step' : undefined}
          >
            {canNavigateBack ? (
              <button
                type="button"
                onClick={() => navigate({ to: step.path })}
                className="flex flex-col items-center rounded-md outline-none transition hover:opacity-85 focus-visible:ring-2 focus-visible:ring-primary/30"
                aria-label={`Edit ${step.label}`}
              >
                {stepMarker}
              </button>
            ) : (
              <div className="flex flex-col items-center">{stepMarker}</div>
            )}

            {!isLast && (
              <span
                className={cn(
                  'mx-2 h-px flex-1 sm:mx-3',
                  isCompleted ? 'bg-primary' : 'bg-border',
                )}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
