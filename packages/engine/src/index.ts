import type { Answer, BuyerIntel, Claim, Evidence } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import type { z } from 'zod';
import { claimCheck as claimCheckImpl } from './claims';
import { draftAnswersImpl, type Question } from './draft';
import { fillFormImpl } from './form';
import { buyerIntelImpl } from './intel';
import { startPackRunImpl } from './start';

export { runPackPipeline, failRun, rerunVerdicts } from './pipeline';
export { runReplay, snapshotRun, findReplay, type ReplaySnapshot } from './replay';
export type { PackRunParams } from './start';
export type { RunCtx, Stepper } from './types';
export { inlineStep } from './types';
export { claimCheckSync, strikeUnsupported, claimTokens, NEEDS_EVIDENCE_TAG } from './claims';
export { evaluateGate, evaluateGates, type GateResult } from './gates';
export { resolveStatus, decide, coverageScore, statusFromGate, SIM } from './matrix-rules';
export { fillDocx, normRef, type FormEntry } from './docx-fill';
export { docxBytesToPages, docxToPages } from './docx-text';
export { filledKey } from './form';
export { buyerIntelImpl, buyerQuery } from './intel';
export { ingestEvidenceImpl } from './evidence-ingest';
export { CAPS, consumeFreshRun, consumeTavilyCall, consumeTavilyRefresh } from './caps';
export { draftAnswersImpl, enforceWordLimit } from './draft';
export { loadChunks, chunkText, ensureEmbeddings, ensureProfileEvidence } from './retrieve';

type ClaimT = z.infer<typeof Claim>;

/** Create a runs row, start the PACK_RUN workflow, return the run id. Fresh runs count against the judge session cap; replays do not. */
export function startPackRun(env: Env, input: { workspaceId: string; tenderId: string; sessionId?: string; replay?: boolean }): Promise<string> {
  return startPackRunImpl(env, input);
}

/** Draft answers (MODEL_FAST, thinking off) from evidence; every claim is checked in code and recorded. */
export function draftAnswers(env: Env, input: { workspaceId: string; tenderId: string; lot?: string; questions: Question[] }): Promise<Answer[]> {
  return draftAnswersImpl(env, input);
}

/** Split `text` into claims and check each against the evidence (certifications, SLAs, headcounts, client names, money, dates). */
export function claimCheck(text: string, evidence: Evidence[]): Promise<ClaimT[]> {
  return claimCheckImpl(text, evidence);
}

/** Buyer intelligence; `refresh` makes a live Tavily call (KV-cached, capped per session and per day). */
export function buyerIntel(env: Env, buyerKey: string, opts: { refresh: boolean; sessionId?: string }): Promise<BuyerIntel> {
  return buyerIntelImpl(env, buyerKey, opts);
}

/** Fill the buyer's own DOCX form with approved answers; returns the R2 key of the filled file. */
export function fillForm(env: Env, docId: string, answers: Answer[]): Promise<string> {
  return fillFormImpl(env, docId, answers);
}
