"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { Badge, Button, Field, Icon, controlClass, cx } from "@/components/ui";
import {
  PARSE_MESSAGE,
  checkCoordinates,
  parseCoordinates,
} from "@/lib/geocoding";
import {
  previewOrderGeocode,
  type AddressGeocodePreview,
} from "@/lib/data/mutations";
import { COUNTRIES, country } from "@/lib/regions";
import type { CountryCode } from "@/lib/regions";
import type { LatLng, Order } from "@/lib/types";

export type AddressPatch = {
  delivery_address: string;
  delivery_postcode: string | null;
  delivery_country: CountryCode;
  delivery_location: LatLng;
};

/** A Google Maps search for the typed address — the fastest route to the pin. */
function searchUrl(address: string, postcode: string, code: CountryCode) {
  const q = [address, postcode, country(code).name].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/**
 * The form for one order.
 *
 * Mounted with `key={order.id}` so stepping to the next order remounts it with
 * fresh state. Re-seeding six fields from an effect would be the same thing
 * done worse, and would fight whatever the dispatcher had already typed.
 *
 * Two ways in: an order that never geocoded (needs a first coordinate), and an
 * order being **redirected** to a different drop-off because the customer
 * asked. The second one arrives with an address and a pin already, so the
 * fields are seeded from it and only what changes has to be retyped.
 */
function AddressForm({
  order,
  geocodingReady,
  onSave,
  onClose,
}: {
  order: Order;
  /** GEOCODING_API_KEY is set — offer a one-click lookup instead of a manual pin. */
  geocodingReady: boolean;
  onSave: (orderId: string, patch: AddressPatch) => void;
  onClose: () => void;
}) {
  const redirecting = order.delivery_location !== null;

  const [address, setAddress] = useState(order.delivery_address);
  const [postcode, setPostcode] = useState(order.delivery_postcode ?? "");
  const [code, setCode] = useState<CountryCode>(order.delivery_country);
  const [paste, setPaste] = useState("");
  const [lat, setLat] = useState(
    order.delivery_location ? String(order.delivery_location.lat) : "",
  );
  const [lng, setLng] = useState(
    order.delivery_location ? String(order.delivery_location.lng) : "",
  );
  const [parsed, setParsed] = useState<ReturnType<typeof parseCoordinates>>({
    point: null,
    failure: null,
    source: null,
  });
  const [lookup, setLookup] = useState<AddressGeocodePreview | null>(null);
  const [looking, startLooking] = useTransition();

  /** Parsed on input rather than in an effect — the paste *is* the event. */
  const handlePaste = (value: string) => {
    setPaste(value);
    const result = parseCoordinates(value);
    setParsed(result);
    if (result.point) {
      setLat(String(result.point.lat));
      setLng(String(result.point.lng));
    }
  };

  const runLookup = () =>
    startLooking(async () => {
      const result = await previewOrderGeocode(
        address.trim(),
        code,
        postcode.trim() === "" ? null : postcode.trim(),
      );
      setLookup(result);
      if (result.point) {
        setLat(String(result.point.lat));
        setLng(String(result.point.lng));
      }
    });

  const point: LatLng | null = useMemo(() => {
    const la = Number.parseFloat(lat.replace(",", "."));
    const ln = Number.parseFloat(lng.replace(",", "."));
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
    if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
    return { lat: la, lng: ln };
  }, [lat, lng]);

  // Coordinates that came in with the order and have not been touched — no need
  // to make the dispatcher re-confirm a pin they are not changing.
  const pointUnchanged =
    redirecting &&
    point !== null &&
    order.delivery_location !== null &&
    point.lat === order.delivery_location.lat &&
    point.lng === order.delivery_location.lng;

  const check = point ? checkCoordinates(point, code) : null;
  const spec = country(code);
  const postcodeOdd =
    postcode.trim() !== "" && !spec.postcodePattern.test(postcode.trim());

  const save = () => {
    if (!point) return;
    onSave(order.id, {
      delivery_address: address.trim(),
      delivery_postcode: postcode.trim() === "" ? null : postcode.trim(),
      delivery_country: code,
      delivery_location: point,
    });
  };

  return (
    <>
      <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {redirecting ? (
          <p className="flex items-start gap-2 rounded-sm border border-hairline bg-surface-muted px-3 py-2.5 text-caption text-ink-muted">
            <Icon name="alt_route" className="mt-px text-[16px] text-ink-subtle" />
            This order already has a drop-off point. Change the address to send
            the driver somewhere else — the stop moves on the fleet map and any
            route is re-driven from the new point. Blocked once the stop has been
            delivered.
          </p>
        ) : null}

        <section className="space-y-3">
          <Field
            label="Delivery address"
            htmlFor="fix-address"
            hint="This is what the driver sees and what the geofence is drawn around."
          >
            <textarea
              id="fix-address"
              rows={2}
              className={cx(controlClass, "h-auto py-2")}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-[1fr_10rem] gap-3">
            <Field label={spec.postcodeLabel} htmlFor="fix-postcode">
              <input
                id="fix-postcode"
                className={controlClass}
                value={postcode}
                placeholder={spec.postcodeExample}
                onChange={(e) => setPostcode(e.target.value)}
              />
            </Field>
            <Field label="Country" htmlFor="fix-country">
              <select
                id="fix-country"
                className={controlClass}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              >
                {Object.values(COUNTRIES).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {postcodeOdd ? (
            <p className="flex items-start gap-1.5 text-caption text-warn">
              <Icon name="warning" className="mt-px text-[14px]" />
              Does not match the {spec.postcodeLabel} format (e.g.{" "}
              {spec.postcodeExample}). Saving anyway is fine.
            </p>
          ) : null}
        </section>

        <section>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-heading text-ink">Coordinates</h3>
            {!geocodingReady ? (
              <Badge tone="warn" title="No geocoding provider is configured">
                Manual
              </Badge>
            ) : null}
            {geocodingReady ? (
              <Button
                icon={looking ? "progress_activity" : "explore_nearby"}
                disabled={looking}
                onClick={runLookup}
              >
                {looking ? "Looking up…" : "Look up address"}
              </Button>
            ) : null}
            <a
              href={searchUrl(address, postcode, code)}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-sm border border-hairline-strong bg-surface px-2.5 text-body-sm font-medium text-ink transition-colors hover:bg-surface-muted"
            >
              <Icon name="travel_explore" className="text-[16px]" />
              Find in Google Maps
            </a>
          </div>
          <p className="mb-3 text-caption text-ink-subtle">
            {geocodingReady
              ? "Look up the address for a pin, or drop one in Google Maps, right-click the exact spot and paste the coordinates below. A town-centre match is refused — it would sit inside the geofence."
              : "No geocoding key is set, so this address cannot be resolved automatically. Open it in Google Maps, right-click the exact spot, copy the coordinates and paste them below — a full Maps URL works too."}
          </p>

          {lookup ? (
            lookup.ok ? (
              <p className="mb-3 flex items-start gap-1.5 rounded-sm border border-ok-border bg-ok-soft px-3 py-2 text-caption text-ink-muted">
                <Icon name="check_circle" className="mt-px text-[14px] text-ok" />
                <span>
                  Matched{lookup.matchedBy === "eircode" ? " via Eircode" : ""}:{" "}
                  <span className="text-ink">
                    {lookup.formatted ?? "coordinates filled in below"}
                  </span>
                  {lookup.message ? ` — ${lookup.message}` : ""}
                </span>
              </p>
            ) : (
              <p className="mb-3 flex items-start gap-1.5 rounded-sm border border-warn-border bg-warn-soft px-3 py-2 text-caption text-ink-muted">
                <Icon name="error" className="mt-px text-[14px] text-warn" />
                <span>
                  {lookup.message ?? "No usable match."} Place it by hand from
                  Google Maps instead.
                </span>
              </p>
            )
          ) : null}

          <Field label="Paste from Google Maps" htmlFor="fix-paste">
            <input
              id="fix-paste"
              className={controlClass}
              value={paste}
              placeholder="54.7975, -8.2839   ·   or a maps.google.com link"
              onChange={(e) => handlePaste(e.target.value)}
            />
          </Field>

          {paste.trim() !== "" && parsed.failure ? (
            <p className="mt-2 flex items-start gap-1.5 text-caption text-danger">
              <Icon name="error" className="mt-px text-[14px]" />
              {PARSE_MESSAGE[parsed.failure]}
            </p>
          ) : null}
          {parsed.point && parsed.source ? (
            <p className="mt-2 flex items-start gap-1.5 text-caption text-ok">
              <Icon name="check_circle" className="mt-px text-[14px]" />
              Read {parsed.source}.
            </p>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Latitude" htmlFor="fix-lat">
              <input
                id="fix-lat"
                className={cx(controlClass, "font-mono")}
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
            </Field>
            <Field label="Longitude" htmlFor="fix-lng">
              <input
                id="fix-lng"
                className={cx(controlClass, "font-mono")}
                value={lng}
                onChange={(e) => setLng(e.target.value)}
              />
            </Field>
          </div>

          {pointUnchanged ? (
            <p className="mt-3 flex items-start gap-1.5 text-caption text-ink-subtle">
              <Icon name="info" className="mt-px text-[14px]" />
              Still the original drop-off point. Look up the new address or paste
              a pin to move it.
            </p>
          ) : null}

          {check?.level === "transposed" ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-sm border border-warn-border bg-warn-soft px-3 py-2.5">
              <Icon name="swap_horiz" className="text-[18px] text-warn" />
              <p className="min-w-0 flex-1 text-caption text-ink-muted">
                {check.message}
              </p>
              <Button
                icon="swap_horiz"
                onClick={() => {
                  setLat(String(check.swapped.lat));
                  setLng(String(check.swapped.lng));
                }}
              >
                Swap
              </Button>
            </div>
          ) : null}

          {check?.level === "wrong_country" ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-sm border border-warn-border bg-warn-soft px-3 py-2.5">
              <Icon name="public" className="text-[18px] text-warn" />
              <p className="min-w-0 flex-1 text-caption text-ink-muted">
                {check.message}
              </p>
              {check.suggested ? (
                <Button onClick={() => setCode(check.suggested as CountryCode)}>
                  Set country to {check.suggested}
                </Button>
              ) : null}
            </div>
          ) : null}

          {check?.level === "unknown_area" ? (
            <p className="mt-3 flex items-start gap-1.5 text-caption text-warn">
              <Icon name="warning" className="mt-px text-[14px]" />
              {check.message}
            </p>
          ) : null}

          {check?.level === "ok" ? (
            <p className="mt-3 flex items-start gap-1.5 text-caption text-ok">
              <Icon name="verified" className="mt-px text-[14px]" />
              Inside {spec.name}.
            </p>
          ) : null}
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-6 py-3">
        <p className="mr-auto max-w-xs text-caption text-ink-subtle">
          {point
            ? redirecting
              ? "The stop moves to the new point on the fleet map."
              : "The stop will appear on the fleet map and can be routed to."
            : "A coordinate is required — the geofence needs a point, not an address."}
        </p>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="save" disabled={!point} onClick={save}>
          {redirecting ? "Save new address" : "Save address"}
        </Button>
      </footer>
    </>
  );
}

export function FixAddressesDialog({
  orders,
  startWith,
  geocodingReady,
  onSave,
  onClose,
}: {
  /** The order(s) the dialog steps through — the ungeocoded batch, or one row. */
  orders: Order[];
  startWith?: string | null;
  geocodingReady: boolean;
  onSave: (orderId: string, patch: AddressPatch) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => {
    const found = orders.findIndex((o) => o.id === startWith);
    return found === -1 ? 0 : found;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The list shrinks as addresses are fixed, so the index can run off the end.
  const safeIndex = Math.min(index, orders.length - 1);
  const order = orders[safeIndex];
  if (!order) return null;

  const batch = orders.length > 1;
  const redirecting = order.delivery_location !== null;
  const title = redirecting && !batch ? "Change delivery address" : "Fix delivery address";

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-x-4 top-[5vh] z-50 mx-auto flex max-h-[90vh] max-w-2xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div className="min-w-0">
            <p className="font-mono text-label uppercase text-ink-subtle">
              {batch
                ? `${safeIndex + 1} of ${orders.length} to fix`
                : redirecting
                  ? "Redirect delivery"
                  : "Needs coordinates"}
            </p>
            <h2 className="text-title text-ink">{title}</h2>
            <p className="mt-0.5 truncate text-body-sm text-ink-muted">
              <span className="font-mono text-data-sm">{order.crm_order_id}</span>{" "}
              · {order.customer_name}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {batch ? (
              <>
                <Button
                  icon="chevron_left"
                  aria-label="Previous order"
                  disabled={safeIndex === 0}
                  onClick={() => setIndex(safeIndex - 1)}
                />
                <Button
                  icon="chevron_right"
                  aria-label="Next order"
                  disabled={safeIndex === orders.length - 1}
                  onClick={() => setIndex(safeIndex + 1)}
                />
              </>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-sm p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
            >
              <Icon name="close" className="text-[20px]" />
            </button>
          </div>
        </header>

        <AddressForm
          key={order.id}
          order={order}
          geocodingReady={geocodingReady}
          onSave={onSave}
          onClose={onClose}
        />
      </div>
    </>
  );
}
