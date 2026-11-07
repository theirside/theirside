import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, CopyButton, Field } from './ui';

function QrCode({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    // loaded only here, so the QR encoder stays out of the main bundle
    void import('qrcode-generator').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      if (alive) setSvg(qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true }));
    });
    return () => {
      alive = false;
    };
  }, [text]);
  // generated locally from our own otpauth:// URL; never leaves the browser
  return (
    <div
      className="qr"
      aria-label="QR code for your authenticator app"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Recovery codes, shown once: copy or download before continuing. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([`Theirside recovery codes\n\n${text}\n`], { type: 'text/plain' }),
    );
    a.download = 'theirside-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="stack">
      <p>
        <b>Save these recovery codes.</b> Each one signs you in once if you lose your phone. They
        are shown only now.
      </p>
      <pre className="summary recovery" data-testid="recovery-codes">
        {text}
      </pre>
      <div className="row">
        <CopyButton text={text} label="Copy codes" />
        <Button type="button" onClick={download}>
          Download
        </Button>
        <Button variant="primary" type="button" onClick={onDone}>
          I saved them
        </Button>
      </div>
    </div>
  );
}

/** Set up an authenticator app: QR code (or the secret), then a code to confirm. */
export function TwoFactorSetup({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  if (!setup)
    return (
      <div className="stack">
        <p>
          Use an authenticator app (1Password, Google Authenticator, Authy, Microsoft
          Authenticator…). After your password, Theirside will ask for the 6-digit code it shows.
        </p>
        {error && <div className="error">{error}</div>}
        <div>
          <Button
            variant="primary"
            type="button"
            onClick={() =>
              void api<{ secret: string; otpauthUrl: string }>('/v1/account/2fa/setup', {
                method: 'POST',
              }).then(setSetup, (e) => setError((e as Error).message))
            }
          >
            Set up two-factor sign-in
          </Button>
        </div>
      </div>
    );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        api<{ recoveryCodes: string[] }>('/v1/account/2fa/enable', {
          method: 'POST',
          body: { code },
        }).then(
          (r) => setCodes(r.recoveryCodes),
          (err) => setError((err as Error).message),
        );
      }}
    >
      <p>1. Scan this with your authenticator app:</p>
      <QrCode text={setup.otpauthUrl} />
      <p className="muted">
        Can't scan? Enter this key: <code data-testid="totp-secret">{setup.secret}</code>
      </p>
      <Field>
        2. Enter the 6-digit code it shows
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          name="code"
          maxLength={7}
        />
      </Field>
      {error && <div className="error">{error}</div>}
      <div>
        <Button variant="primary" type="submit">
          Turn on
        </Button>
      </div>
    </form>
  );
}
