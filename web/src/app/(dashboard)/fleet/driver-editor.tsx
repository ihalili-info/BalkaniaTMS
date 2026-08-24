"use client";

import { useEffect, useState, useTransition } from "react";

import { Button, Field, Icon, controlClass, cx } from "@/components/ui";
import { createDriver, updateDriver, type DriverInput } from "@/lib/data/mutations";
import { COUNTRIES, HOME_COUNTRY, country } from "@/lib/regions";
import type { CountryCode } from "@/lib/regions";
import type { Driver, Truck } from "@/lib/types";

/**
 * Add or edit a driver.
 *
 * Reveal has no driver records for this fleet, so they are entered here. Only
 * the identity and licence fields — the Reg. 561/2006 duty counters are not
 * editable, because a typed-in "hours driven" would be indistinguishable from
 * a tachograph reading while carrying none of its authority.
 */
export function DriverEditor({
  driver,
  trucks,
  otherDrivers,
  onClose,
  onSaved,
}: {
  /** null for a new driver. */
  driver: Driver | null;
  /** Every truck, so a vehicle can be assigned without leaving this dialog. */
  trucks: Truck[];
  /** Used only to say who else is already on the chosen truck. */
  otherDrivers: Driver[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(driver?.full_name ?? "");
  const [phone, setPhone] = useState(driver?.phone ?? "");
  const [homeCountry, setHomeCountry] = useState<CountryCode>(
    driver?.home_country ?? HOME_COUNTRY,
  );
  const [card, setCard] = useState(driver?.tachograph_card_no ?? "");
  const [cpc, setCpc] = useState(driver?.cpc_expires_on?.slice(0, 10) ?? "");
  const [licence, setLicence] = useState(driver?.driving_licence_no ?? "");
  const [truckId, setTruckId] = useState(driver?.assigned_truck_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    setError(null);
    const input: DriverInput = {
      full_name: fullName,
      phone,
      home_country: homeCountry,
      tachograph_card_no: card,
      cpc_expires_on: cpc,
      driving_licence_no: licence,
      assigned_truck_id: truckId === "" ? null : truckId,
    };
    startTransition(async () => {
      const result = driver
        ? await updateDriver(driver.id, input)
        : await createDriver(input);
      if (result.ok) onSaved();
      else setError(result.message ?? "Could not save.");
    });
  };

  const chosen = trucks.find((t) => t.id === truckId) ?? null;
  // A truck can carry two drivers on opposite shifts, so this is information,
  // not an error — but a silent second assignment is how a truck ends up
  // double-booked.
  const sharedWith =
    truckId === ""
      ? []
      : otherDrivers.filter((d) => d.assigned_truck_id === truckId);

  const dialPrefix = country(homeCountry).dialPrefix;
  const phoneOdd =
    phone.trim() !== "" && !phone.replace(/[\s()-]/g, "").startsWith("+");

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={driver ? `Edit ${driver.full_name}` : "Add driver"}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <p className="font-mono text-label uppercase text-ink-subtle">
              {driver ? "Edit driver" : "New driver"}
            </p>
            <h2 className="text-title text-ink">
              {driver?.full_name || "Add a driver"}
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

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <section className="space-y-3">
            <Field label="Full name" htmlFor="d-name">
              <input
                id="d-name"
                className={controlClass}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Declan Murphy"
              />
            </Field>

            <div className="grid grid-cols-[1fr_9rem] gap-3">
              <Field
                label="Phone"
                htmlFor="d-phone"
                hint="Where route messages go. Include the country code."
              >
                <input
                  id="d-phone"
                  className={controlClass}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={`${dialPrefix} 87 123 4567`}
                />
              </Field>
              <Field label="Home country" htmlFor="d-country">
                <select
                  id="d-country"
                  className={controlClass}
                  value={homeCountry}
                  onChange={(e) => setHomeCountry(e.target.value)}
                >
                  {Object.values(COUNTRIES).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {phoneOdd ? (
              <p className="flex items-start gap-1.5 text-caption text-warn">
                <Icon name="warning" className="mt-px text-[14px]" />
                No country code — route messages may fail. Expected{" "}
                {dialPrefix}…
              </p>
            ) : null}
          </section>

          <section className="space-y-2 border-t border-hairline pt-5">
            <Field
              label="Assigned vehicle"
              htmlFor="d-truck"
              hint="The truck this driver normally runs. Planning default only — a load can still be given any truck."
            >
              <select
                id="d-truck"
                className={controlClass}
                value={truckId}
                onChange={(e) => setTruckId(e.target.value)}
              >
                <option value="">No vehicle assigned</option>
                {trucks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.license_plate}
                    {t.label ? ` — ${t.label}` : ""}
                    {t.availability !== "available"
                      ? ` (${t.availability.replace("_", " ")})`
                      : ""}
                  </option>
                ))}
              </select>
            </Field>

            {trucks.length === 0 ? (
              <p className="flex items-start gap-1.5 text-caption text-ink-subtle">
                <Icon name="info" className="mt-px text-[14px]" />
                No trucks yet. Add them on the Trucks tab, or pull them from
                Reveal with Sync fleet.
              </p>
            ) : null}

            {sharedWith.length > 0 ? (
              <p className="flex items-start gap-1.5 text-caption text-ink-muted">
                <Icon name="group" className="mt-px text-[14px]" />
                Also assigned to {sharedWith.map((d) => d.full_name).join(", ")}.
                That is allowed — double-shifting one unit is normal — but worth
                knowing before you plan.
              </p>
            ) : null}

            {chosen && chosen.availability !== "available" ? (
              <p className="flex items-start gap-1.5 text-caption text-warn">
                <Icon name="warning" className="mt-px text-[14px]" />
                {chosen.license_plate} is marked{" "}
                {chosen.availability.replace("_", " ")}, so it will not appear
                when planning a load.
              </p>
            ) : null}
          </section>

          <section className="space-y-3">
            <h3 className="text-heading text-ink">Licences</h3>

            <Field
              label="Tachograph card"
              htmlFor="d-card"
              hint="Reg. (EU) 165/2014. Unique per driver — it is what the tachograph feed reports duty against."
            >
              <input
                id="d-card"
                className={cx(controlClass, "font-mono")}
                value={card}
                onChange={(e) => setCard(e.target.value)}
                placeholder="IE-DC-004182-33"
              />
            </Field>

            <Field
              label="Driver CPC expires"
              htmlFor="d-cpc"
              hint="Directive 2003/59/EC. A lapsed CPC means they may not drive commercially."
            >
              <input
                id="d-cpc"
                type="date"
                className={controlClass}
                value={cpc}
                onChange={(e) => setCpc(e.target.value)}
              />
            </Field>

            <Field label="Driving licence" htmlFor="d-licence">
              <input
                id="d-licence"
                className={cx(controlClass, "font-mono")}
                value={licence}
                onChange={(e) => setLicence(e.target.value)}
              />
            </Field>
          </section>

          <section className="rounded-md border border-hairline bg-surface-muted px-3 py-3">
            <p className="mb-1 font-mono text-label uppercase text-ink-subtle">
              Driving time · not editable
            </p>
            <p className="text-caption text-ink-muted">
              The Reg. 561/2006 counters are written by the tachograph sync,
              which is not connected. They are deliberately not editable here —
              a typed figure would look exactly like a real reading while
              carrying none of its authority, and the tachograph is the legal
              record.
            </p>
          </section>

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-sm border border-danger-border bg-danger-soft px-3 py-2 text-body-sm text-danger"
            >
              <Icon name="error" className="mt-px text-[17px]" />
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-hairline px-5 py-3">
          <Button
            variant="primary"
            icon={pending ? "progress_activity" : "save"}
            onClick={save}
            disabled={pending || fullName.trim() === ""}
            className="flex-1 justify-center"
          >
            {pending ? "Saving…" : driver ? "Save changes" : "Add driver"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </footer>
      </aside>
    </>
  );
}
