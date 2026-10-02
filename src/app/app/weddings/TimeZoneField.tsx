"use client";

import { useRef, useState } from "react";

import { inputClass, secondaryButtonClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import { timeZoneLabel } from "@/lib/weddings/timezone";

type Props = {
  id: string;
  /** The server's list of selectable IANA zones. */
  options: readonly string[];
  defaultValue: string;
  error?: string;
};

/**
 * "Zona horaria": a native select of IANA zones (keyboard, screen-reader and
 * mobile friendly), defaulting to "Sin definir". Nothing is ever chosen
 * silently: the device's zone is used only when the person presses the
 * button, the choice is shown and stays editable, and the server validates
 * whatever is submitted. No geolocation, no IP lookup.
 */
export function TimeZoneField({ id, options, defaultValue, error }: Props) {
  const copy = getMessages().weddingNew;
  const selectRef = useRef<HTMLSelectElement>(null);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // A stored zone the list doesn't offer (e.g. "UTC") stays selectable.
  const choices =
    defaultValue && !options.includes(defaultValue) ? [defaultValue, ...options] : options;

  function applyDeviceTimeZone() {
    let zone: string | undefined;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      zone = undefined;
    }
    const select = selectRef.current;
    if (!select || !zone || !choices.includes(zone)) {
      setDeviceMessage(copy.timeZoneDeviceUnavailable);
      return;
    }
    select.value = zone;
    setDeviceMessage(interpolate(copy.timeZoneDeviceUsed, { zone: timeZoneLabel(zone) }));
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {copy.timeZoneLabel}
      </label>
      <select
        ref={selectRef}
        id={id}
        name="timeZone"
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        onChange={() => setDeviceMessage(null)}
        className={inputClass}
      >
        <option value="">{copy.timeZoneNone}</option>
        {choices.map((zone) => (
          <option key={zone} value={zone}>
            {timeZoneLabel(zone)}
          </option>
        ))}
      </select>
      <p id={hintId} className="text-muted text-sm">
        {copy.timeZoneHint}
      </p>
      <button
        type="button"
        onClick={applyDeviceTimeZone}
        className={`${secondaryButtonClass} min-h-9 px-3 py-1.5`}
      >
        {copy.timeZoneUseDevice}
      </button>
      <p role="status" className="text-sm">
        {deviceMessage}
      </p>
      {error ? (
        <p id={errorId} className="text-danger text-sm font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}
