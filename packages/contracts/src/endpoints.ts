import { z } from 'zod';
import { defineEndpoint as ep, type AnyEndpoint as AnyEndpointT } from './endpoint';
import { PageQuery } from './common';
import { Workspace } from './entities-company';
import { Answer, Audit, BuyerIntel, Intake, Verdict } from './entities-tender';
import {
  ApiKey, DesignRequest, Evidence, PactovioEvent, Product, Quote, WebhookDelivery, WebhookEndpoint,
  ConnectorCatalogItem,
} from './entities-ops';
import * as V from './views';
import { ProductInput } from './catalogue';

const id = z.object({ id: z.string() });
const empty = z.object({ ok: z.boolean() });
const TenderListQuery = PageQuery.extend({
  q: z.string().optional(),
  country: z.string().optional(),
  status: z.enum(['new', 'shortlisted', 'dismissed', 'bidding']).optional(),
  min_fit: z.coerce.number().optional(),
});

/** The single source of truth for the HTTP surface. API routes, OpenAPI and the typed client all derive from this. */
export const endpoints = {
  health: ep({ id: 'health', method: 'GET', path: '/health', tag: 'system', summary: 'Liveness and binding check', response: V.Health, status: 'live', lane: 'foundation', public: true }),
  getSession: ep({ id: 'getSession', method: 'GET', path: '/session', tag: 'workspaces', summary: 'Current verified customer, private workspace and caps', response: V.SessionInfo, status: 'live', lane: 'foundation' }),

  listWorkspaces: ep({ id: 'listWorkspaces', method: 'GET', path: '/workspaces', tag: 'workspaces', summary: 'List the authenticated private workspace', response: z.object({ items: z.array(Workspace) }), status: 'live', lane: 'foundation' }),
  getWorkspace: ep({ id: 'getWorkspace', method: 'GET', path: '/workspaces/{id}', tag: 'workspaces', summary: 'Get a workspace', params: id, response: Workspace, status: 'live', lane: 'foundation' }),
  switchWorkspace: ep({ id: 'switchWorkspace', method: 'POST', path: '/workspaces/switch', tag: 'workspaces', summary: 'Confirm the current private workspace; other IDs are forbidden', body: z.object({ workspace_id: z.string() }), response: V.SessionInfo, status: 'live', lane: 'foundation' }),

  getToday: ep({ id: 'getToday', method: 'GET', path: '/today', tag: 'today', summary: 'Today feed: matches, closing soon, intakes, approvals, expiring certs', response: V.TodayFeed, status: 'sample', lane: 'foundation' }),

  listTenders: ep({ id: 'listTenders', method: 'GET', path: '/tenders', tag: 'tenders', summary: 'Matched tenders for the workspace', query: TenderListQuery, response: V.TenderList, status: 'sample', lane: 'sources' }),
  getTender: ep({ id: 'getTender', method: 'GET', path: '/tenders/{id}', tag: 'tenders', summary: 'Tender with documents, latest run, verdicts', params: id, response: V.TenderDetail, status: 'sample', lane: 'sources' }),
  startPackRun: ep({ id: 'startPackRun', method: 'POST', path: '/tenders/{id}/runs', tag: 'tenders', summary: 'Start a pack run (read, extract, verdict). `replay` plays the showcase run', params: id, body: V.StartRunBody, response: V.StartRunResult, status: 'live', lane: 'engine' }),
  getMatrix: ep({ id: 'getMatrix', method: 'GET', path: '/tenders/{id}/matrix', tag: 'tenders', summary: 'Requirement matrix with statuses and evidence links', params: id, response: V.Matrix, status: 'live', lane: 'engine' }),
  getVerdicts: ep({ id: 'getVerdicts', method: 'GET', path: '/tenders/{id}/verdicts', tag: 'tenders', summary: 'Per-lot bid / no-bid verdicts', params: id, response: z.object({ items: z.array(Verdict) }), status: 'live', lane: 'engine' }),
  listAnswers: ep({ id: 'listAnswers', method: 'GET', path: '/tenders/{id}/answers', tag: 'tenders', summary: 'Drafted answers with claim checks', params: id, response: z.object({ items: z.array(Answer) }), status: 'live', lane: 'engine' }),
  draftAnswer: ep({ id: 'draftAnswer', method: 'POST', path: '/tenders/{id}/answers/draft', tag: 'tenders', summary: 'Draft one answer from evidence (claim-checked)', params: id, body: V.DraftAnswerBody, response: Answer, status: 'live', lane: 'engine' }),
  patchAnswer: ep({ id: 'patchAnswer', method: 'PATCH', path: '/tenders/{id}/answers/{answerId}', tag: 'tenders', summary: 'Edit or approve an answer', params: z.object({ id: z.string(), answerId: z.string() }), body: V.PatchAnswerBody, response: Answer, status: 'live', lane: 'engine' }),
  fillForm: ep({ id: 'fillForm', method: 'POST', path: '/tenders/{id}/forms/{docId}/fill', tag: 'tenders', summary: "Fill the buyer's own DOCX form with approved answers", params: z.object({ id: z.string(), docId: z.string() }), body: V.FillFormBody, response: V.FillFormResult, status: 'live', lane: 'engine' }),
  downloadForm: ep({ id: 'downloadForm', method: 'GET', path: '/tenders/{id}/forms/{docId}/filled', tag: 'tenders', summary: 'Download the filled form (DOCX)', params: z.object({ id: z.string(), docId: z.string() }), response: z.unknown(), status: 'live', lane: 'engine', kind: 'binary' }),

  getRun: ep({ id: 'getRun', method: 'GET', path: '/runs/{id}', tag: 'runs', summary: 'Run with its steps', params: id, response: V.RunDetail, status: 'live', lane: 'engine' }),
  streamRun: ep({ id: 'streamRun', method: 'GET', path: '/runs/{id}/stream', tag: 'runs', summary: 'SSE stream of run steps (event: step | done)', params: id, response: z.unknown(), status: 'live', lane: 'engine', kind: 'sse' }),

  getBuyer: ep({ id: 'getBuyer', method: 'GET', path: '/buyers/{id}', tag: 'buyers', summary: 'Buyer intelligence by buyer_key', params: id, response: BuyerIntel, status: 'live', lane: 'engine' }),
  refreshBuyer: ep({ id: 'refreshBuyer', method: 'POST', path: '/buyers/{id}/refresh', tag: 'buyers', summary: 'Refresh buyer intel with a live Tavily search (capped per session)', params: id, response: V.RefreshBuyerResult, status: 'live', lane: 'engine' }),

  listEvidence: ep({ id: 'listEvidence', method: 'GET', path: '/evidence', tag: 'evidence', summary: 'Evidence library', query: PageQuery, response: z.object({ items: z.array(Evidence) }), status: 'sample', lane: 'pack' }),
  getEvidence: ep({ id: 'getEvidence', method: 'GET', path: '/evidence/{id}', tag: 'evidence', summary: 'One evidence item', params: id, response: Evidence, status: 'sample', lane: 'pack' }),
  uploadEvidence: ep({ id: 'uploadEvidence', method: 'POST', path: '/evidence', tag: 'evidence', summary: 'Upload evidence (multipart: file, title, kind, valid_to)', response: V.EvidenceUploadResult, status: 'live', lane: 'pack', kind: 'multipart' }),

  listIntakes: ep({ id: 'listIntakes', method: 'GET', path: '/intakes', tag: 'intakes', summary: 'Inbox of intakes (all three doors)', query: PageQuery.extend({ door: z.enum(['tender', 'rfp', 'design']).optional(), status: z.string().optional() }), response: z.object({ items: z.array(Intake) }), status: 'live', lane: 'connectors' }),
  getIntake: ep({ id: 'getIntake', method: 'GET', path: '/intakes/{id}', tag: 'intakes', summary: 'One intake with documents', params: id, response: V.IntakeDetail, status: 'live', lane: 'connectors' }),
  createIntake: ep({ id: 'createIntake', method: 'POST', path: '/intakes', tag: 'intakes', summary: 'Create an intake by upload (multipart) or pasted text (JSON)', body: V.IntakeCreateBody, response: V.IntakeCreateResult, status: 'live', lane: 'connectors' }),

  listDesignRequests: ep({ id: 'listDesignRequests', method: 'GET', path: '/design-requests', tag: 'design', summary: 'Design requests from customers', response: z.object({ items: z.array(DesignRequest) }), status: 'sample', lane: 'quote' }),
  getDesignRequest: ep({ id: 'getDesignRequest', method: 'GET', path: '/design-requests/{id}', tag: 'design', summary: 'Design request with requirements and product matches', params: id, response: DesignRequest, status: 'sample', lane: 'quote' }),
  matchDesignRequest: ep({ id: 'matchDesignRequest', method: 'POST', path: '/design-requests/{id}/match', tag: 'design', summary: 'Extract requirements and match against the product catalogue', params: id, response: DesignRequest, status: 'live', lane: 'quote' }),
  quoteDesignRequest: ep({ id: 'quoteDesignRequest', method: 'POST', path: '/design-requests/{id}/quote', tag: 'design', summary: 'Create a priced quote from the matches', params: id, body: V.QuoteFromDesignBody, response: Quote, status: 'live', lane: 'quote' }),
  listProducts: ep({ id: 'listProducts', method: 'GET', path: '/products', tag: 'design', summary: 'Product catalogue', response: z.object({ items: z.array(Product) }), status: 'sample', lane: 'quote' }),
  createProduct: ep({ id: 'createProduct', method: 'POST', path: '/products', tag: 'design', summary: 'Add a customer product and price', body: ProductInput, response: Product, status: 'live', lane: 'quote' }),
  updateProduct: ep({ id: 'updateProduct', method: 'PUT', path: '/products/{id}', tag: 'design', summary: 'Update an owned product and price', params: id, body: ProductInput, response: Product, status: 'live', lane: 'quote' }),

  listQuotes: ep({ id: 'listQuotes', method: 'GET', path: '/quotes', tag: 'quotes', summary: 'Quotes', response: z.object({ items: z.array(Quote) }), status: 'sample', lane: 'quote' }),
  getQuote: ep({ id: 'getQuote', method: 'GET', path: '/quotes/{id}', tag: 'quotes', summary: 'One quote', params: id, response: Quote, status: 'sample', lane: 'quote' }),
  exportQuote: ep({ id: 'exportQuote', method: 'GET', path: '/quotes/{id}/export', tag: 'quotes', summary: 'Export quote as DOCX or XLSX', params: id, query: V.ExportQuoteQuery, response: z.unknown(), status: 'live', lane: 'quote', kind: 'binary' }),

  listConnectors: ep({ id: 'listConnectors', method: 'GET', path: '/connectors', tag: 'connectors', summary: 'Connector catalogue with live status', response: z.object({ items: z.array(ConnectorCatalogItem) }), status: 'live', lane: 'connectors' }),
  connectConnector: ep({ id: 'connectConnector', method: 'POST', path: '/connectors/{id}/connect', tag: 'connectors', summary: 'Start OAuth; returns the redirect URL (id = provider)', params: id, body: V.ConnectBody, response: V.ConnectResult, status: 'live', lane: 'connectors' }),
  disconnectConnector: ep({ id: 'disconnectConnector', method: 'POST', path: '/connectors/{id}/disconnect', tag: 'connectors', summary: 'Disconnect a provider', params: id, response: empty, status: 'live', lane: 'connectors' }),
  testConnector: ep({ id: 'testConnector', method: 'POST', path: '/connectors/{id}/test', tag: 'connectors', summary: 'Run a test action on a connected provider', params: id, body: V.TestActionBody, response: V.TestActionResult, status: 'live', lane: 'connectors' }),
  setConnectorRules: ep({ id: 'setConnectorRules', method: 'PATCH', path: '/connectors/{id}/rules', tag: 'connectors', summary: 'Choose which events trigger which actions on a connector (id = provider)', params: id, body: V.ConnectorRulesBody, response: V.ConnectorRulesResult, status: 'live', lane: 'connectors' }),

  listWebhooks: ep({ id: 'listWebhooks', method: 'GET', path: '/webhooks', tag: 'webhooks', summary: 'Outbound webhook endpoints', response: z.object({ items: z.array(WebhookEndpoint) }), status: 'live', lane: 'foundation' }),
  createWebhook: ep({ id: 'createWebhook', method: 'POST', path: '/webhooks', tag: 'webhooks', summary: 'Create endpoint; secret is returned once', body: V.WebhookCreateBody, response: V.WebhookCreateResult, status: 'live', lane: 'foundation' }),
  deleteWebhook: ep({ id: 'deleteWebhook', method: 'DELETE', path: '/webhooks/{id}', tag: 'webhooks', summary: 'Delete endpoint', params: id, response: empty, status: 'live', lane: 'foundation' }),
  listWebhookDeliveries: ep({ id: 'listWebhookDeliveries', method: 'GET', path: '/webhooks/{id}/deliveries', tag: 'webhooks', summary: 'Delivery log', params: id, response: z.object({ items: z.array(WebhookDelivery) }), status: 'live', lane: 'foundation' }),

  listApiKeys: ep({ id: 'listApiKeys', method: 'GET', path: '/api-keys', tag: 'apikeys', summary: 'API keys (prefix only)', response: z.object({ items: z.array(ApiKey) }), status: 'live', lane: 'foundation' }),
  createApiKey: ep({ id: 'createApiKey', method: 'POST', path: '/api-keys', tag: 'apikeys', summary: 'Create key; full key shown once', body: V.ApiKeyCreateBody, response: V.ApiKeyCreateResult, status: 'live', lane: 'foundation' }),
  revokeApiKey: ep({ id: 'revokeApiKey', method: 'DELETE', path: '/api-keys/{id}', tag: 'apikeys', summary: 'Revoke key', params: id, response: empty, status: 'live', lane: 'foundation' }),

  getIcsInfo: ep({ id: 'getIcsInfo', method: 'GET', path: '/ics', tag: 'ics', summary: 'Calendar feed URL (deadlines of matched tenders), served at /ics/{token}.ics', response: V.IcsInfo, status: 'live', lane: 'foundation' }),

  listAgentThreads: ep({ id: 'listAgentThreads', method: 'GET', path: '/agent/threads', tag: 'agent', summary: 'Agent chat threads', response: z.object({ items: z.array(V.AgentThread) }), status: 'live', lane: 'agent' }),
  createAgentThread: ep({ id: 'createAgentThread', method: 'POST', path: '/agent/threads', tag: 'agent', summary: 'New thread', response: V.AgentThread, status: 'live', lane: 'agent' }),
  listAgentMessages: ep({ id: 'listAgentMessages', method: 'GET', path: '/agent/threads/{id}/messages', tag: 'agent', summary: 'Messages in a thread', params: id, response: z.object({ items: z.array(V.AgentMessage) }), status: 'live', lane: 'agent' }),
  sendAgentMessage: ep({ id: 'sendAgentMessage', method: 'POST', path: '/agent/threads/{id}/messages', tag: 'agent', summary: 'Send a message (HTTP fallback; prefer the WebSocket)', params: id, body: V.AgentMessageBody, response: V.AgentMessage, status: 'live', lane: 'agent' }),
  confirmAgentAction: ep({ id: 'confirmAgentAction', method: 'POST', path: '/agent/actions/{id}/confirm', tag: 'agent', summary: 'Approve a pending agent action', params: id, response: V.PendingAction, status: 'live', lane: 'agent' }),
  declineAgentAction: ep({ id: 'declineAgentAction', method: 'POST', path: '/agent/actions/{id}/decline', tag: 'agent', summary: 'Decline a pending agent action', params: id, response: V.PendingAction, status: 'live', lane: 'agent' }),
  postAgentMessage: ep({ id: 'postAgentMessage', method: 'POST', path: '/agent/messages', tag: 'agent', summary: 'Send a chat message without a WebSocket; runs the whole turn and returns it', body: V.AgentChatBody, response: V.AgentTurnResult, status: 'live', lane: 'agent' }),
  decideAgentAction: ep({ id: 'decideAgentAction', method: 'POST', path: '/agent/actions/{id}', tag: 'agent', summary: 'Confirm or decline a pending agent action ({ decision })', params: id, body: V.AgentActionDecisionBody, response: V.PendingAction, status: 'live', lane: 'agent' }),
  streamAgentEvents: ep({ id: 'streamAgentEvents', method: 'GET', path: '/agent/events', tag: 'agent', summary: 'SSE of the agent\'s proactive messages (event: message), for outbound subscribers such as the self-host desk agent', response: z.unknown(), status: 'live', lane: 'agent', kind: 'sse' }),
  runAgentDigest: ep({ id: 'runAgentDigest', method: 'POST', path: '/agent/digest', tag: 'agent', summary: 'Post the morning digest now', response: V.AgentDigestResult, status: 'live', lane: 'agent' }),
  agentSocket: ep({ id: 'agentSocket', method: 'GET', path: '/agent/ws', tag: 'agent', summary: 'WebSocket upgrade to the AgentHub Durable Object (frames: AgentWsMessage)', response: z.unknown(), status: 'live', lane: 'agent', kind: 'ws' }),

  getBilling: ep({ id: 'getBilling', method: 'GET', path: '/billing', tag: 'billing', summary: 'Plan and credit balance', response: V.BillingState, status: 'sample', lane: 'billing' }),
  billingCheckout: ep({ id: 'billingCheckout', method: 'POST', path: '/billing/checkout', tag: 'billing', summary: 'Dodo checkout URL', body: V.CheckoutBody, response: V.UrlResult, status: 'stub', lane: 'billing' }),
  billingPortal: ep({ id: 'billingPortal', method: 'POST', path: '/billing/portal', tag: 'billing', summary: 'Dodo customer portal URL', response: V.UrlResult, status: 'stub', lane: 'billing' }),

  getLimits: ep({ id: 'getLimits', method: 'GET', path: '/limits', tag: 'limits', summary: 'Real caps and usage for this session', response: V.Limits, status: 'live', lane: 'foundation' }),

  listEvents: ep({ id: 'listEvents', method: 'GET', path: '/events', tag: 'events', summary: 'Recent events', query: V.EventsQuery, response: z.object({ items: z.array(PactovioEvent) }), status: 'live', lane: 'foundation' }),
  streamEvents: ep({ id: 'streamEvents', method: 'GET', path: '/events/stream', tag: 'events', summary: 'SSE stream of workspace events (event: <type>)', response: z.unknown(), status: 'live', lane: 'foundation', kind: 'sse' }),

  ingestAudit: ep({ id: 'ingestAudit', method: 'POST', path: '/ingest/audit', tag: 'ingest', summary: 'Nebius audit job posts its result (x-ingest-secret header)', body: V.AuditResultBody, response: empty, status: 'stub', lane: 'audit', public: true }),
  getAudit: ep({ id: 'getAudit', method: 'GET', path: '/audits/{id}', tag: 'ingest', summary: 'Audit result', params: id, response: Audit, status: 'stub', lane: 'audit' }),
} as const;

export type EndpointKey = keyof typeof endpoints;
export const endpointList = Object.values(endpoints) as AnyEndpointT[];
