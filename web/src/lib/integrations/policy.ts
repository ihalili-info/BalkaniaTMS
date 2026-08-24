/**
 * Customer messaging policy and copy.
 *
 * Real configuration, not fixtures: the three template bodies are what
 * customers actually receive, and the GDPR positions are the decisions the
 * operator is required to have made and be able to show.
 */

import type { NotificationType } from "@/lib/types";

/* --- GDPR / ePrivacy -------------------------------------------------------
   The alerts carry a customer name, phone number, address and timestamp. That
   is personal data, and the settings screen is where the operator records the
   decisions the regulation requires them to have made. */

export interface PrivacySetting {
  id: string;
  label: string;
  value: string;
  basis: string;
  icon: string;
}

export const privacySettings: PrivacySetting[] = [
  {
    id: "lawful_basis",
    label: "Lawful basis for alerts",
    value: "Performance of a contract — Art. 6(1)(b)",
    basis:
      "Delivery alerts are transactional, not marketing, so no prior opt-in is required. Anything promotional would need separate consent.",
    icon: "gavel",
  },
  {
    id: "retention",
    label: "Notification retention",
    value: "90 days, then purged",
    basis:
      "Art. 5(1)(e) storage limitation. A scheduled job deletes notifications rows past the window; idx_notifications_sent_at keeps it cheap.",
    icon: "auto_delete",
  },
  {
    id: "opt_out",
    label: "Opt-out keyword",
    value: "STOP (also STOPP, ARRÊT)",
    basis:
      "A reply sets orders.notifications_opt_out and must be honoured immediately and permanently, across every future order for that number.",
    icon: "notifications_off",
  },
  {
    id: "minimisation",
    label: "Data minimisation",
    value: "Phone + address only",
    basis:
      "Art. 5(1)(c). The CRM webhook must not carry payment details, dates of birth or anything else the delivery does not need.",
    icon: "shield",
  },
  {
    id: "processors",
    label: "Processors",
    value: "Sent (sent.dm), Supabase, Vercel",
    basis:
      "Each needs a data processing agreement. Check the transfer mechanism for any processing outside the EEA.",
    icon: "handshake",
  },
  {
    id: "residency",
    label: "Data residency",
    value: "Compute in dub1 — database not yet pinned",
    basis:
      "Vercel functions are pinned to Dublin (dub1) in vercel.json; the default would have been iad1 in the US. Supabase must still be provisioned in an EU region. UK customer data may also move under the UK GDPR adequacy decision.",
    icon: "database",
  },
];

/** Copy sent to customers, one template per notification type. */
export const messageTemplates: Record<
  NotificationType,
  { trigger: string; body: string }
> = {
  dispatch_confirmation: {
    trigger: "Load assigned and marked en route",
    body: "Your order {{crm_order_id}} has been loaded and is on the way.",
  },
  proximity_alert: {
    trigger: "Truck enters the 5 km geofence around the stop",
    body: "Our driver is approximately 15 minutes away from your location.",
  },
  delivery_complete: {
    trigger: "load_items.delivered_at is set",
    body: "Order {{crm_order_id}} delivered successfully. Thank you.",
  },
};
