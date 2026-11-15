import { MapPin } from 'lucide-react';
import { isGeoPoint } from '@lumibase/contracts/field';
import { formatPoint } from '../geo/map-config';
import type { DisplayComponent } from './types';

/** `geopoint` — `21.02850, 105.85420` with a pin; anything else renders as a dash (#746). */
export const GeopointDisplay: DisplayComponent<unknown> = ({ value }) => {
  if (!isGeoPoint(value)) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs" title={`lat ${value.lat}, lng ${value.lng}`}>
      <MapPin className="h-3 w-3 text-muted-foreground" />
      {formatPoint(value)}
    </span>
  );
};
