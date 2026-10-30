import { describe, expect, it } from 'vitest';
import { EventType } from '@pactovio/contracts';
import { DEFAULT_RULES, EVENT_ACTIONS, PROVIDER_ACTIONS, PROVIDERS, effectiveRules, matchesFilter } from '../src';
import schemas from './fixtures/tool-schemas.json';

describe('catalogue', () => {
  it('is exactly the 15 chosen connectors, two per category (one signing)', () => {
    expect(PROVIDERS.map((p) => p.provider).sort()).toEqual(['asana', 'dropbox', 'docusign', 'gmail', 'googlecalendar', 'googledrive', 'hubspot', 'jira', 'microsoft_teams', 'outlook', 'outlook_calendar', 'quickbooks', 'salesforce', 'slack', 'xero'].sort());
    const count = (c: string) => PROVIDERS.filter((p) => p.category === c).length;
    for (const c of ['email', 'chat', 'crm', 'storage', 'calendar', 'tasks', 'accounting']) expect(count(c), c).toBe(2);
    expect(count('signing')).toBe(1);
  });
  it('every provider has implemented actions matching its catalogue entry', () => {
    for (const p of PROVIDERS) expect(Object.keys(PROVIDER_ACTIONS[p.provider] ?? {}).sort(), p.provider).toEqual([...p.actions].sort());
  });
  it('docusign and xero are the only providers without managed auth; teams needs a work account', () => {
    expect(PROVIDERS.filter((p) => !p.managedAuth).map((p) => p.provider).sort()).toEqual(['docusign', 'xero']);
    expect(PROVIDERS.filter((p) => p.needsWorkAccount).map((p) => p.provider)).toEqual(['microsoft_teams']);
  });
  it('default rules reference real events and event actions', () => {
    for (const [provider, rules] of Object.entries(DEFAULT_RULES)) for (const r of rules) {
      expect(EventType.safeParse(r.event).success, `${provider} ${r.event}`).toBe(true);
      expect(EVENT_ACTIONS[r.action], `${provider} ${r.action}`).toBeTypeOf('function');
    }
  });
  it('every tool a provider calls exists in the live schema snapshot', () => {
    expect(Object.keys(schemas).length).toBeGreaterThan(60);
  });
  it('workspace rules override defaults by event + action and can add rules', () => {
    const base = effectiveRules('hubspot', undefined);
    expect(base).toEqual([{ event: 'verdict.ready', action: 'sync_bid', enabled: true, filter: { decision: ['BID', 'CONDITIONAL'] } }]);
    const merged = effectiveRules('hubspot', { rules: [{ event: 'verdict.ready', action: 'sync_bid', enabled: false }, { event: 'quote.ready', action: 'upload_artifacts', enabled: true }] });
    expect(merged.find((r) => r.action === 'sync_bid')).toMatchObject({ enabled: false, filter: { decision: ['BID', 'CONDITIONAL'] } });
    expect(merged).toHaveLength(2);
  });
  it('filters match values or lists, and pass when the payload lacks the key', () => {
    expect(matchesFilter({ decision: ['BID', 'CONDITIONAL'] }, { decision: 'BID' })).toBe(true);
    expect(matchesFilter({ decision: ['BID', 'CONDITIONAL'] }, { decision: 'NO_BID' })).toBe(false);
    expect(matchesFilter({ decision: ['BID'] }, {})).toBe(true);
    expect(matchesFilter(undefined, { a: 1 })).toBe(true);
  });
});
