import {
  NotImplemented, type Answer, type BuyerIntel, type Claim, type Evidence,
} from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import type { z } from 'zod';

type ClaimT = z.infer<typeof Claim>;

/** Lane: engine. Create a runs row, start the PACK_RUN workflow, return the run id. */
export async function startPackRun(
  _env: Env,
  _input: { workspaceId: string; tenderId: string; sessionId?: string; replay?: boolean },
): Promise<string> {
  throw new NotImplemented('engine.startPackRun');
}

/** Lane: engine. Draft answers (MODEL_FAST) from evidence; every claim is checked and recorded. */
export async function draftAnswers(
  _env: Env,
  _input: { workspaceId: string; tenderId: string; lot?: string; questions: { ref: string; question: string; wordLimit?: number }[] },
): Promise<Answer[]> {
  throw new NotImplemented('engine.draftAnswers');
}

/** Lane: engine. Split `text` into claims and check each against the evidence. */
export async function claimCheck(_text: string, _evidence: Evidence[]): Promise<ClaimT[]> {
  throw new NotImplemented('engine.claimCheck');
}

/** Lane: engine. Buyer intelligence; `refresh` makes a live Tavily call (capped per session). */
export async function buyerIntel(_env: Env, _buyerKey: string, _opts: { refresh: boolean; sessionId?: string }): Promise<BuyerIntel> {
  throw new NotImplemented('engine.buyerIntel');
}

/** Lane: engine. Fill the buyer's own DOCX form with approved answers; returns the R2 key of the filled file. */
export async function fillForm(_env: Env, _docId: string, _answers: Answer[]): Promise<string> {
  throw new NotImplemented('engine.fillForm');
}
