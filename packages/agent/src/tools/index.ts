import type { AgentTool } from '../types';
import { billingStatus, buyerIntelTool, getLimits, getMatrix, getTender, getVerdicts, listConnectors, listIntakes, listToday, searchTenders } from './read';
import {
  approveAnswerTool, createDesignRequestTool, createQuoteTool, draftAnswersTool, matchDesignRequestTool, runConnectorActionTool, startPackRunTool,
} from './write';

/** Shared by AgentHub chat and the MCP server. Tools that change state or reach outside return a pending action. */
export const agentTools: AgentTool[] = [
  listToday, searchTenders, getTender, startPackRunTool, getMatrix, getVerdicts, draftAnswersTool, approveAnswerTool,
  buyerIntelTool, listIntakes, createDesignRequestTool, matchDesignRequestTool, createQuoteTool,
  listConnectors, runConnectorActionTool, billingStatus, getLimits,
] as AgentTool[];
