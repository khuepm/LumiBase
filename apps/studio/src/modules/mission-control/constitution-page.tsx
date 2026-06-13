import { ConstitutionEditor } from './constitution-editor';
import { MissionControlLayout } from './layout';

/** Constitution editor sub-route (content-os-ui Req 1.1). */
export function ConstitutionPage() {
  return (
    <MissionControlLayout>
      <div className="rounded-lg border bg-background p-4">
        <ConstitutionEditor />
      </div>
    </MissionControlLayout>
  );
}
