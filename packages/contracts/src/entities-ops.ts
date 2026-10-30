import { z } from 'zod';
import {
  ConnectorStatus, DesignStatus, EventType, Iso, Json, Minor, PlanId, QuoteStatus,
} from './common';

export const Evidence = z.object({
  id: z.string(),
  workspace_id: z.string(),
  kind: z.string(),
  title: z.string(),
  issuer: z.string().nullable(),
  scope: z.string().nullable(),
  valid_to: z.string().nullable(),
  r2_key: z.string().nullable(),
  text: z.string().nullable(),
  meta: Json.nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

export const EvidenceChunk = z.object({
  id: z.string(),
  evidence_id: z.string(),
  workspace_id: z.string(),
  seq: z.number().int(),
  text: z.string(),
  embedding: z.array(z.number()).nullable(),
});
export type EvidenceChunk = z.infer<typeof EvidenceChunk>;

export const Product = z.object({
  id: z.string(),
  workspace_id: z.string(),
  sku: z.string(),
  name: z.string(),
  family: z.string().nullable(),
  specs: Json,
  datasheet_doc_id: z.string().nullable(),
  unit_price_minor: Minor,
  currency: z.string(),
});
export type Product = z.infer<typeof Product>;

export const PriceRule = z.object({
  id: z.string(),
  workspace_id: z.string(),
  kind: z.string(),
  rule: Json,
});
export type PriceRule = z.infer<typeof PriceRule>;

export const DesignRequirement = z.object({
  key: z.string(),
  text: z.string(),
  value: z.string().optional(),
  mandatory: z.boolean().default(true),
});
export const ProductMatch = z.object({
  product_id: z.string(),
  sku: z.string(),
  score: z.number(),
  verdict: z.enum(['FIT', 'PARTIAL', 'NO_FIT']),
  reasons: z.array(z.string()),
  gaps: z.array(z.string()),
});
export const DesignRequest = z.object({
  id: z.string(),
  workspace_id: z.string(),
  intake_id: z.string().nullable(),
  customer: z.string(),
  subject: z.string(),
  spec_text: z.string(),
  requirements: z.array(DesignRequirement),
  matches: z.array(ProductMatch),
  status: DesignStatus,
});
export type DesignRequest = z.infer<typeof DesignRequest>;

export const QuoteLine = z.object({
  sku: z.string().nullable(),
  description: z.string(),
  qty: z.number().int(),
  unit_price_minor: Minor,
  discount_minor: Minor.default(0),
  line_total_minor: Minor,
});
export type QuoteLine = z.infer<typeof QuoteLine>;

export const Quote = z.object({
  id: z.string(),
  workspace_id: z.string(),
  design_request_id: z.string().nullable(),
  tender_id: z.string().nullable(),
  currency: z.string(),
  lines: z.array(QuoteLine),
  subtotal_minor: Minor,
  discount_minor: Minor,
  tax_minor: Minor,
  total_minor: Minor,
  valid_until: Iso.nullable(),
  status: QuoteStatus,
});
export type Quote = z.infer<typeof Quote>;

export const Connector = z.object({
  id: z.string(),
  workspace_id: z.string(),
  provider: z.string(),
  status: ConnectorStatus,
  external_account_id: z.string().nullable(),
  meta: Json.nullable(),
  connected_at: Iso.nullable(),
});
export type Connector = z.infer<typeof Connector>;

export const ConnectorCatalogItem = z.object({
  provider: z.string(),
  name: z.string(),
  category: z.enum(['email', 'chat', 'calendar', 'storage', 'crm', 'tasks']),
  description: z.string(),
  status: ConnectorStatus,
  connected_at: Iso.nullable(),
  external_account_id: z.string().nullable(),
  actions: z.array(z.string()),
});
export type ConnectorCatalogItem = z.infer<typeof ConnectorCatalogItem>;

export const WebhookEndpoint = z.object({
  id: z.string(),
  workspace_id: z.string(),
  url: z.string(),
  events: z.array(EventType),
  active: z.boolean(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

export const WebhookDelivery = z.object({
  id: z.string(),
  endpoint_id: z.string(),
  event: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  response_code: z.number().int().nullable(),
  at: Iso,
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

export const ApiKey = z.object({
  id: z.string(),
  workspace_id: z.string(),
  prefix: z.string(),
  name: z.string(),
  created_at: Iso,
  last_used_at: Iso.nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const PactovioEvent = z.object({
  id: z.string(),
  workspace_id: z.string(),
  type: EventType,
  payload: Json,
  at: Iso,
});
export type PactovioEvent = z.infer<typeof PactovioEvent>;

export const Subscription = z.object({
  workspace_id: z.string(),
  plan: PlanId,
  dodo_customer_id: z.string().nullable(),
  dodo_subscription_id: z.string().nullable(),
  status: z.string(),
  current_period_end: Iso.nullable(),
});
export type Subscription = z.infer<typeof Subscription>;

export const CreditLedgerEntry = z.object({
  id: z.string(),
  workspace_id: z.string(),
  delta: z.number().int(),
  reason: z.string(),
  ref: z.string().nullable(),
  external_event_id: z.string().nullable(),
  at: Iso,
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntry>;
