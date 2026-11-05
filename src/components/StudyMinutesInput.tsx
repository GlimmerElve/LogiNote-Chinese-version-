import React, { useEffect, useRef, useState } from 'react';

interface StudyMinutesInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onFocus' | 'type'> {
  value: number | undefined;
  onValueChange: (value: number | undefined) => void;
  /** A project may inherit the plan's duration by leaving its override empty. */
  allowEmpty?: boolean;
}

/** Keep incomplete keystrokes local. Only valid minutes enter the plan model;
 * blur normalizes the displayed draft instead of replacing an empty field with
 * the minimum after every keypress. */
export function StudyMinutesInput({ value, onValueChange, allowEmpty = false, min = 5, max = 1440, step = 5, ...props }: StudyMinutesInputProps) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const focused = useRef(false);
  const minimum = Number(min), maximum = Number(max);
  useEffect(() => { if (!focused.current) setDraft(value === undefined ? '' : String(value)); }, [value]);
  const commit = () => {
    const parsed = draft.trim() === '' ? undefined : Number(draft);
    const next = parsed === undefined || !Number.isFinite(parsed)
      ? allowEmpty ? undefined : value ?? minimum
      : Math.min(maximum, Math.max(minimum, Math.round(parsed)));
    setDraft(next === undefined ? '' : String(next));
    if (next !== value) onValueChange(next);
  };
  return <input {...props} type="number" min={min} max={max} step={step} value={draft}
    onFocus={() => { focused.current = true; }}
    onChange={event => {
      const raw = event.target.value;
      setDraft(raw);
      if (raw === '') { if (allowEmpty) onValueChange(undefined); return; }
      const next = Number(raw);
      if (Number.isInteger(next) && next >= minimum && next <= maximum) onValueChange(next);
    }}
    onBlur={() => { focused.current = false; commit(); }}
    onKeyDown={event => { if (event.key === 'Enter') commit(); props.onKeyDown?.(event); }} />;
}
