import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DiagramStyle, LabelFlags } from '../scene/types';
import { Legend } from './Legend';
import { storageGet, storageSet } from './storage';

/** Per-annotation visibility, driven by the floating SHOW toggles in the pane. */
export type ShowFlags = Omit<LabelFlags, 'unitRates'>;

export const DEFAULT_FLAGS: ShowFlags = {
  signals: true,
  rates: true,
  buffers: true,
  repetitions: true,
  constructors: true,
  functions: true,
};

const FLAG_LABELS: [keyof ShowFlags, string][] = [
  ['signals', 'signal names'],
  ['rates', 'rates'],
  ['buffers', 'buffer sizes'],
  ['repetitions', 'repetitions'],
  ['constructors', 'constructors'],
  ['functions', 'functions'],
];

/** The floating SHOW toggles and the legend over the diagram. */
export function ShowToggles({
  flags,
  onFlags,
  unitRates,
  onToggleUnitRates,
  style,
}: {
  flags: ShowFlags;
  onFlags(update: (f: ShowFlags) => ShowFlags): void;
  unitRates: boolean;
  onToggleUnitRates(): void;
  style: DiagramStyle;
}) {
  const [open, setOpen] = useState(() => storageGet('showOpen') === '1');
  useEffect(() => storageSet('showOpen', open ? '1' : '0'), [open]);
  const [legendOpen, setLegendOpen] = useState(false);
  return (
    <div className={`float-controls${open ? ' open' : ''}`}>
      <span className="detail-switch" title="Toggle each annotation on the diagram">
        <button className="switch-title" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          show
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {FLAG_LABELS.map(([key, label]) => (
          <span key={key} className="switch-group">
            <button
              className={flags[key] ? 'active' : ''}
              onClick={() => onFlags((f) => ({ ...f, [key]: !f[key] }))}
            >
              {label}
            </button>
            {key === 'rates' && (
              <button
                className={`sub ${unitRates ? 'active' : ''}`}
                disabled={!flags.rates}
                title="Also show rates equal to 1"
                onClick={onToggleUnitRates}
              >
                rates equal to 1
              </button>
            )}
          </span>
        ))}
      </span>
      <button
        className={legendOpen ? 'active' : ''}
        title="Explain the diagram notation"
        onClick={() => setLegendOpen((v) => !v)}
      >
        legend
      </button>
      {legendOpen && <Legend style={style} />}
    </div>
  );
}
