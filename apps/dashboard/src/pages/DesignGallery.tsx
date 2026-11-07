import { contrast } from '@theirside/design/contrast';
import tokens from '@theirside/design/tokens.json';
import { useMemo, useState, type ReactNode } from 'react';
import { Chart, type ChartSeries } from '../components/Chart';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  LegendCheckbox,
  Segmented,
  StatusDot,
  Table,
  Tabs,
} from '../components/ui';

/**
 * #/design: every token and shared component in both themes side by side, for
 * designers and screenshot checks. Open without sign-in when the collector runs
 * with THEIRSIDE_DESIGN_GALLERY (the local/demo compose stack); otherwise the page
 * doesn't exist. Values come from packages/design/tokens.json, never from here.
 */
type Theme = 'light' | 'dark';
type ColorName = keyof typeof tokens.color.light;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Colors({ theme }: { theme: Theme }) {
  const c = tokens.color[theme] as Record<ColorName, string>;
  const textTokens = new Set<string>(tokens.contrast.text);
  return (
    <div className="gallery-swatches">
      {(Object.keys(c) as ColorName[]).map((name) => (
        <div key={name} className="gallery-swatch" data-token={`--color-${name}`}>
          <span className="gallery-chip" style={{ background: `var(--color-${name})` }} />
          <span>
            <code>--color-{name}</code>
            <br />
            <span className="muted">
              {c[name]}
              {textTokens.has(name) &&
                ` · ${contrast(c[name], c.background).toFixed(1)}:1 on background`}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartColors({ theme }: { theme: Theme }) {
  return (
    <div className="gallery-swatches">
      {tokens.chart[theme].map((hex, i) => (
        <div key={i} className="gallery-swatch">
          <span className="gallery-chip" style={{ background: `var(--chart-${i + 1})` }} />
          <span>
            <code>--chart-{i + 1}</code>
            <br />
            <span className="muted">{hex}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Type() {
  return (
    <div className="stack">
      {Object.entries(tokens.type).map(([k, v]) => (
        <div
          key={k}
          style={{ fontSize: `var(--text-${k})`, lineHeight: `var(--leading-${k})` }}
          className="gallery-type"
        >
          <code className="muted">
            --text-{k} {v.size}/{v.line}
          </code>{' '}
          Acme Cards answering 401 for 62% of calls
        </div>
      ))}
      <div>
        {Object.entries(tokens.weight).map(([k]) => (
          <span key={k} style={{ fontWeight: `var(--weight-${k})` }} className="gallery-weight">
            {k}
          </span>
        ))}
      </div>
      <code>POST /v2/cards/:id/activate · Roboto Mono for code and endpoints</code>
    </div>
  );
}

function Spacing() {
  return (
    <div className="stack">
      {Object.entries(tokens.space).map(([k, px]) => (
        <div key={k} className="row">
          <code className="gallery-label">--space-{k.replace('.', '_')}</code>
          <span
            className="gallery-bar"
            style={{ width: `var(--space-${k.replace('.', '_')})` }}
            aria-hidden
          />
          <span className="muted">{px}px</span>
        </div>
      ))}
    </div>
  );
}

function Shapes() {
  return (
    <div className="gallery-shapes">
      {Object.keys(tokens.radius).map((k) => (
        <div key={k} className="gallery-shape" style={{ borderRadius: `var(--radius-${k})` }}>
          <code>--radius-{k}</code>
        </div>
      ))}
      {Object.keys(tokens.shadow.light).map((k) => (
        <div key={k} className="gallery-shape" style={{ boxShadow: `var(--shadow-${k})` }}>
          <code>--shadow-{k}</code>
        </div>
      ))}
      <button type="button" className="btn gallery-focus">
        focus ring
      </button>
    </div>
  );
}

const T0 = Date.UTC(2026, 10, 7, 12, 0);
const TIMES = Array.from({ length: 60 }, (_, i) => new Date(T0 + i * 60_000).toISOString());
const wave = (base: number, amp: number, phase: number) =>
  TIMES.map((_, i) => Math.max(0, base + amp * Math.sin(i / 6 + phase)));

function Components() {
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('24h');
  const [tab, setTab] = useState('all');
  const [legend, setLegend] = useState({ a: true, b: false });
  const series = useMemo<ChartSeries[]>(
    () => [
      { label: 'http_5xx', values: wave(0.04, 0.03, 0), color: 'var(--chart-6)' },
      { label: 'timeout', values: wave(0.02, 0.015, 1), color: 'var(--chart-3)' },
      {
        label: 'normal',
        values: TIMES.map(() => 0.01),
        color: 'var(--color-healthy)',
        dash: true,
      },
    ],
    [],
  );
  return (
    <div className="stack">
      <Section title="Button">
        <div className="row">
          <Button variant="primary">Save</Button>
          <Button>Cancel</Button>
          <Button variant="danger">Revoke</Button>
          <Button size="small">small</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>
      <Section title="Badge">
        <div className="row">
          <Badge>alerts off</Badge>
          <Badge tone="danger">incident</Badge>
          <Badge tone="healthy">New</Badge>
          <Badge tone="warning">low volume</Badge>
          <Badge tone="info">admin</Badge>
          <Badge tone="danger" href="#/design">
            linked
          </Badge>
        </div>
      </Section>
      <Section title="StatusDot">
        <div className="row">
          {(['green', 'amber', 'red', 'idle', 'unknown'] as const).map((s) => (
            <StatusDot key={s} status={s} label />
          ))}
        </div>
      </Section>
      <Section title="Tabs and Segmented">
        <Tabs
          value="providers"
          items={[
            { id: 'providers', label: 'Providers', href: '#/design' },
            { id: 'alerts', label: 'Alert channels', href: '#/design' },
          ]}
        />
        <div className="row">
          <Tabs
            variant="sub"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'all', label: 'All' },
              { id: 'hidden', label: 'Hidden' },
            ]}
          />
          <Segmented value={range} options={['1h', '24h', '7d']} onChange={setRange} />
        </div>
      </Section>
      <Section title="Callout">
        <Callout>Few recovery codes left: make new ones.</Callout>
        <Callout tone="danger" title="Provider limit reached">
          New hosts are collected under Other.
        </Callout>
        <Callout tone="info">Discovered in the last 24 h: GeoAPI.</Callout>
      </Section>
      <Card title="Card" actions={<Button size="small">Action</Button>}>
        24px padding on all sides; 16px between this header and the content.
      </Card>
      <Section title="Table">
        <Table>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th className="num">Calls/min</th>
              <th className="num">Errors</th>
            </tr>
          </thead>
          <tbody>
            <tr className="clickable">
              <td>
                <code>POST /v2/cards/:id/activate</code>
              </td>
              <td className="num">42.0</td>
              <td className="num bad">38.0%</td>
            </tr>
            <tr>
              <td>
                <code>GET /v1/users/:id</code>
              </td>
              <td className="num">8.5</td>
              <td className="num">0.2%</td>
            </tr>
          </tbody>
        </Table>
      </Section>
      <Section title="Field">
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <Field label="Support email" hint="added to the incident summary">
            <input type="email" placeholder="support@acme.test" />
          </Field>
          <Field label="Support URL">
            <input />
          </Field>
          <Field label="Role">
            <select>
              <option>member</option>
            </select>
          </Field>
          <Field check label="Send the invite by email">
            <input type="checkbox" defaultChecked />
          </Field>
          <Field wide label="Notes" hint="a wide field spans the row">
            <textarea rows={2} />
          </Field>
        </form>
      </Section>
      <Section title="LegendCheckbox and Chart">
        <div className="row">
          <LegendCheckbox
            label="shown"
            color="var(--chart-1)"
            checked={legend.a}
            onChange={(a) => setLegend({ ...legend, a })}
          />
          <LegendCheckbox
            label="hidden"
            color="var(--chart-2)"
            checked={legend.b}
            onChange={(b) => setLegend({ ...legend, b })}
          />
        </div>
        <Chart times={TIMES} series={series} format={(v) => `${(v * 100).toFixed(1)}%`} />
      </Section>
    </div>
  );
}

function ThemePanel({ theme }: { theme: Theme }) {
  return (
    <div className="gallery-theme" data-theme={theme} data-testid={`gallery-${theme}`}>
      <h2>{theme === 'light' ? 'Light' : 'Dark'}</h2>
      <Section title="Colours">
        <Colors theme={theme} />
      </Section>
      <Section title="Chart series">
        <ChartColors theme={theme} />
      </Section>
      <Section title="Type">
        <Type />
      </Section>
      <Section title="Spacing (4px grid)">
        <Spacing />
      </Section>
      <Section title="Radii, shadows, focus">
        <Shapes />
      </Section>
      <Components />
    </div>
  );
}

export function DesignGallery() {
  return (
    <div className="gallery">
      <header className="page-h">
        <h1>Theirside design system</h1>
        <span className="muted">
          Tokens: <code>packages/design/tokens.json</code> · rules:{' '}
          <code>docs/design-system.md</code>
        </span>
      </header>
      <div className="gallery-grid">
        <ThemePanel theme="light" />
        <ThemePanel theme="dark" />
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p className="muted">
        <a href="#/">Back to the dashboard</a>
      </p>
    </main>
  );
}
