import { MissionControlLayout } from './layout';
import { TrustLedger } from './trust-ledger';

/** Trust ledger sub-route (content-os-ui Req 1.1). */
export function TrustPage() {
  return (
    <MissionControlLayout>
      <div className="rounded-lg border bg-background p-4">
        <TrustLedger />
      </div>
    </MissionControlLayout>
  );
}
