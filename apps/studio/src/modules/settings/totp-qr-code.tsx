import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * QR code for TOTP setup (#1047), drawn in the browser from the `otpauth://`
 * URI. The URI carries the shared secret, so it is encoded locally and never
 * sent to a QR service. Loaded lazily (`React.lazy`) so the encoder stays out
 * of the Studio's initial bundle.
 *
 * Black on white with a 4-module quiet zone whatever the theme: authenticator
 * apps fail to scan a light-on-dark or edge-to-edge code.
 */
export default function TotpQrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((svg) => {
        if (!cancelled) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return <p className="text-xs text-muted-foreground">Could not draw the QR code. Enter the secret below instead.</p>;
  }
  return (
    <div className="inline-block rounded-md bg-white p-2 shadow-sm ring-1 ring-border">
      {src ? (
        <img
          src={src}
          width={192}
          height={192}
          alt="QR code to scan with your authenticator app"
          data-testid="totp-qr-code"
          className="block h-48 w-48"
        />
      ) : (
        <div className="h-48 w-48" aria-hidden="true" />
      )}
    </div>
  );
}
