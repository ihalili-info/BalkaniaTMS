"use client";

import { useEffect, useState } from "react";

import {
  Button,
  Field,
  FeatureChip,
  Icon,
  controlClass,
  cx,
} from "@/components/ui";
import { DEMO_NOW } from "@/lib/demo/fleet";
import { COUNTRIES, vehicleBreaches } from "@/lib/regions";
import { formatCoords, relativeTime } from "@/lib/format";
import {
  TRUCK_FEATURES,
  describeFeature,
  toFeatureId,
} from "@/lib/truck-features";
import type { Truck, TruckAvailability } from "@/lib/types";

const AVAILABILITY_OPTIONS: {
  value: TruckAvailability;
  label: string;
  icon: string;
}[] = [
  { value: "available", label: "Available", icon: "check_circle" },
  { value: "unavailable", label: "Unavailable", icon: "block" },
  { value: "maintenance", label: "Maintenance", icon: "construction" },
];

/** `<input type="date">` speaks YYYY-MM-DD; the column stores timestamptz. */
const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const fromDateInput = (value: string) =>
  value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;

/** Empty string → null, so a cleared field stores NULL rather than "". */
const toNullableInt = (value: string) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const toNullableNum = (value: string) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const toNullableText = (value: string) => {
  const t = value.trim();
  return t === "" ? null : t;
};

export function TruckEditor({
  truck,
  onSave,
  onClose,
}: {
  truck: Truck;
  onSave: (patch: Partial<Truck>) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(truck.label ?? "");
  const [makeModel, setMakeModel] = useState(truck.make_model ?? "");
  const [gpsDeviceId, setGpsDeviceId] = useState(truck.gps_device_id);
  const [kg, setKg] = useState(truck.capacity_kg?.toString() ?? "");
  const [m3, setM3] = useState(truck.capacity_m3?.toString() ?? "");
  const [pallets, setPallets] = useState(truck.pallet_slots?.toString() ?? "");
  const [gross, setGross] = useState(truck.gross_weight_kg?.toString() ?? "");
  const [height, setHeight] = useState(truck.height_m?.toString() ?? "");
  const [length, setLength] = useState(truck.length_m?.toString() ?? "");
  const [euro, setEuro] = useState(truck.euro_emission_class?.toString() ?? "");
  const [adrClasses, setAdrClasses] = useState(truck.adr_classes.join(", "));
  const [features, setFeatures] = useState<string[]>(truck.features);
  const [customTag, setCustomTag] = useState("");
  const [availability, setAvailability] = useState(truck.availability);
  const [note, setNote] = useState(truck.availability_note ?? "");
  const [until, setUntil] = useState(toDateInput(truck.unavailable_until));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleFeature = (id: string) =>
    setFeatures((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id],
    );

  const addCustomTag = () => {
    const id = toFeatureId(customTag);
    if (id && !features.includes(id)) setFeatures((prev) => [...prev, id]);
    setCustomTag("");
  };

  // Which destination countries this vehicle would be illegal in, recomputed
  // live so the dispatcher sees it while typing rather than after saving.
  const overLimitIn = Object.values(COUNTRIES)
    .filter(
      (c) =>
        vehicleBreaches(
          {
            gross_weight_kg: toNullableInt(gross),
            height_m: toNullableNum(height),
            length_m: toNullableNum(length),
          },
          c.code,
        ).length > 0,
    )
    .map((c) => c.name);

  const customTags = features.filter(
    (f) => !TRUCK_FEATURES.some((known) => known.id === f),
  );

  const save = () => {
    const isAvailable = availability === "available";
    onSave({
      label: toNullableText(label),
      make_model: toNullableText(makeModel),
      gps_device_id: gpsDeviceId.trim(),
      capacity_kg: toNullableInt(kg),
      capacity_m3: toNullableNum(m3),
      pallet_slots: toNullableInt(pallets),
      gross_weight_kg: toNullableInt(gross),
      height_m: toNullableNum(height),
      length_m: toNullableNum(length),
      euro_emission_class: toNullableInt(euro),
      adr_classes: adrClasses
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      features,
      availability,
      // Both only mean anything while the truck is out of service, and the
      // `trucks_unavailable_until_requires_reason` CHECK rejects a date left
      // behind on an available truck.
      availability_note: isAvailable ? null : toNullableText(note),
      unavailable_until: isAvailable ? null : fromDateInput(until),
    });
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/20 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${truck.license_plate}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <p className="font-mono text-label uppercase text-ink-subtle">
              Edit truck
            </p>
            <h2 className="font-mono text-title text-ink">
              {truck.license_plate}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <Icon name="close" className="text-[20px]" />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section className="space-y-3">
            <Field label="Name" htmlFor="label" hint="How dispatchers refer to it">
              <input
                id="label"
                className={controlClass}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Reefer 1"
              />
            </Field>
            <Field label="Make & model" htmlFor="make">
              <input
                id="make"
                className={controlClass}
                value={makeModel}
                onChange={(e) => setMakeModel(e.target.value)}
                placeholder="Mercedes-Benz Actros 1845"
              />
            </Field>
          </section>

          <section>
            <h3 className="mb-3 text-heading text-ink">Capacity</h3>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Payload" htmlFor="kg">
                <div className="relative">
                  <input
                    id="kg"
                    type="number"
                    min={1}
                    className={cx(controlClass, "pr-8")}
                    value={kg}
                    onChange={(e) => setKg(e.target.value)}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-caption text-ink-subtle">
                    kg
                  </span>
                </div>
              </Field>
              <Field label="Volume" htmlFor="m3">
                <div className="relative">
                  <input
                    id="m3"
                    type="number"
                    min={1}
                    step="0.5"
                    className={cx(controlClass, "pr-8")}
                    value={m3}
                    onChange={(e) => setM3(e.target.value)}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-caption text-ink-subtle">
                    m³
                  </span>
                </div>
              </Field>
              <Field label="Pallets" htmlFor="pallets">
                <input
                  id="pallets"
                  type="number"
                  min={1}
                  className={controlClass}
                  value={pallets}
                  onChange={(e) => setPallets(e.target.value)}
                />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-heading text-ink">
              Weights &amp; dimensions
            </h3>
            <p className="mb-3 text-caption text-ink-subtle">
              Directive 96/53/EC. Ireland and the UK allow 4.65 m; most of
              mainland Europe caps at 4.00 m — a trailer legal at home can be
              over the limit abroad.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Gross" htmlFor="gross" hint="GVW / MAM">
                <div className="relative">
                  <input
                    id="gross"
                    type="number"
                    min={1}
                    className={cx(controlClass, "pr-8")}
                    value={gross}
                    onChange={(e) => setGross(e.target.value)}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-caption text-ink-subtle">
                    kg
                  </span>
                </div>
              </Field>
              <Field label="Height" htmlFor="height">
                <div className="relative">
                  <input
                    id="height"
                    type="number"
                    min={0}
                    step="0.01"
                    className={cx(controlClass, "pr-7")}
                    value={height}
                    onChange={(e) => setHeight(e.target.value)}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-caption text-ink-subtle">
                    m
                  </span>
                </div>
              </Field>
              <Field label="Length" htmlFor="length">
                <div className="relative">
                  <input
                    id="length"
                    type="number"
                    min={0}
                    step="0.01"
                    className={cx(controlClass, "pr-7")}
                    value={length}
                    onChange={(e) => setLength(e.target.value)}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-caption text-ink-subtle">
                    m
                  </span>
                </div>
              </Field>
            </div>

            {overLimitIn.length > 0 ? (
              <p className="mt-3 flex items-start gap-1.5 rounded-sm border border-warn-border bg-warn-soft px-2.5 py-2 text-caption text-ink-muted">
                <Icon name="public_off" className="mt-px text-[15px] text-warn" />
                <span>Over the limit in {overLimitIn.join(", ")}.</span>
              </p>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Euro class" htmlFor="euro" hint="Low-emission zones">
                <select
                  id="euro"
                  className={controlClass}
                  value={euro}
                  onChange={(e) => setEuro(e.target.value)}
                >
                  <option value="">Not recorded</option>
                  {[3, 4, 5, 6, 7].map((n) => (
                    <option key={n} value={n}>
                      Euro {["", "I", "II", "III", "IV", "V", "VI", "VII"][n]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="ADR classes"
                htmlFor="adr"
                hint="Comma separated, e.g. 3, 8"
              >
                <input
                  id="adr"
                  className={controlClass}
                  value={adrClasses}
                  onChange={(e) => setAdrClasses(e.target.value)}
                  placeholder="3, 8"
                />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-heading text-ink">Equipment</h3>
            <p className="mb-3 text-caption text-ink-subtle">
              Used to match a load&rsquo;s requirements against the fleet.
            </p>
            <ul className="space-y-1">
              {TRUCK_FEATURES.map((feature) => {
                const on = features.includes(feature.id);
                return (
                  <li key={feature.id}>
                    <label
                      className={cx(
                        "flex cursor-pointer items-center gap-2.5 rounded-sm border px-2.5 py-2 transition-colors",
                        on
                          ? "border-brand-border bg-brand-soft"
                          : "border-transparent hover:bg-surface-muted",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleFeature(feature.id)}
                        className="size-3.5 accent-brand"
                      />
                      <Icon
                        name={feature.icon}
                        className={cx(
                          "text-[18px]",
                          on ? "text-brand" : "text-ink-subtle",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cx(
                            "block text-body-sm",
                            on ? "font-medium text-ink" : "text-ink-muted",
                          )}
                        >
                          {feature.label}
                        </span>
                        {feature.hint ? (
                          <span className="block text-caption text-ink-subtle">
                            {feature.hint}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <div className="mt-3">
              <Field
                label="Other equipment"
                htmlFor="custom-tag"
                hint="Anything not listed above — stored as a free-form tag."
              >
                <div className="flex gap-2">
                  <input
                    id="custom-tag"
                    className={controlClass}
                    value={customTag}
                    onChange={(e) => setCustomTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomTag();
                      }
                    }}
                    placeholder="e.g. Double-deck floor"
                  />
                  <Button
                    icon="add"
                    onClick={addCustomTag}
                    disabled={toFeatureId(customTag) === ""}
                  >
                    Add
                  </Button>
                </div>
              </Field>
              {customTags.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {customTags.map((tag) => (
                    <li key={tag}>
                      <FeatureChip
                        feature={describeFeature(tag)}
                        onRemove={() => toggleFeature(tag)}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-heading text-ink">Availability</h3>
            <p className="mb-3 text-caption text-ink-subtle">
              Whether the planner may give this truck work. Being on a load
              today is tracked separately, from the load itself.
            </p>
            <div className="flex gap-1 rounded-sm border border-hairline bg-surface-muted p-1">
              {AVAILABILITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAvailability(option.value)}
                  aria-pressed={availability === option.value}
                  className={cx(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-xs px-2 py-1.5 text-body-sm transition-colors",
                    availability === option.value
                      ? "bg-surface font-medium text-ink shadow-card"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  <Icon name={option.icon} className="text-[16px]" />
                  {option.label}
                </button>
              ))}
            </div>

            {availability !== "available" ? (
              <div className="mt-3 space-y-3">
                <Field label="Reason" htmlFor="note">
                  <textarea
                    id="note"
                    rows={2}
                    className={cx(controlClass, "h-auto py-2")}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Gearbox service booked at the Prishtina depot"
                  />
                </Field>
                <Field label="Back in service" htmlFor="until">
                  <input
                    id="until"
                    type="date"
                    className={controlClass}
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </Field>
              </div>
            ) : null}
          </section>

          <section>
            <h3 className="mb-1 text-heading text-ink">GPS matching</h3>
            <p className="mb-3 text-caption text-ink-subtle">
              Reveal&rsquo;s Vehicle Number, not the device serial or ESN.
              Verizon never sets this on its own — it has to match what is
              entered for this vehicle in Reveal, or the GPS webhook has
              nothing to match the incoming fix against.
            </p>
            <Field label="GPS device ID" htmlFor="gps-device-id">
              <input
                id="gps-device-id"
                className={controlClass}
                value={gpsDeviceId}
                onChange={(e) => setGpsDeviceId(e.target.value)}
                placeholder="e.g. 10234"
              />
            </Field>
          </section>

          {/* Owned by the telematics feed, so read-only here. Showing it makes
              the ownership split visible instead of implied. */}
          <section className="rounded-md border border-hairline bg-surface-muted px-3 py-3">
            <p className="mb-2 font-mono text-label uppercase text-ink-subtle">
              From the GPS feed · read-only
            </p>
            <dl className="space-y-1.5">
              {[
                ["Position", formatCoords(truck.current_location)],
                [
                  "Last fix",
                  relativeTime(truck.location_updated_at, DEMO_NOW),
                ],
              ].map(([term, value]) => (
                <div key={term} className="flex justify-between gap-3">
                  <dt className="text-caption text-ink-subtle">{term}</dt>
                  <dd className="font-mono text-data-sm text-ink-muted">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <footer className="flex items-center gap-2 border-t border-hairline px-5 py-3">
          <Button
            variant="primary"
            icon="save"
            onClick={save}
            disabled={gpsDeviceId.trim() === ""}
            className="flex-1 justify-center"
          >
            Save changes
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </footer>
      </aside>
    </>
  );
}
