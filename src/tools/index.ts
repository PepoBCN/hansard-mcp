import { findMemberTool } from './findMember.js';
import { findConstituencyTool } from './findConstituency.js';
import { memberOverviewTool } from './memberOverview.js';
import { memberVotingHistoryTool } from './memberVotingHistory.js';
import { memberInterestsTool } from './memberInterests.js';
import { searchHansardTool } from './searchHansard.js';
import { getDebateTool } from './getDebate.js';
import { topicTrackerTool } from './topicTracker.js';
import { searchDivisionsTool } from './searchDivisions.js';
import { getDivisionTool } from './getDivision.js';
import { getBillTool } from './getBill.js';
import { getCommitteeTool } from './getCommittee.js';
import { getStateOfPartiesTool } from './getStateOfParties.js';
import { getMinisterialRolesTool } from './getMinisterialRoles.js';
import { getElectionResultsTool } from './getElectionResults.js';
import type { ToolDefinition } from './registry.js';
import { compatTools } from '../compat.js';

/**
 * Full surface — the 15 tools the previous engine exposed, rebuilt.
 *
 * `rawTools` are the tools as written. `tools` is what the server registers:
 * the same 15, wrapped so they also accept the legacy 0.2.0 input names. See
 * `src/compat.ts` for why, and for what is still missing.
 */
export const rawTools: ToolDefinition[] = [
  // members & constituencies
  findMemberTool,
  findConstituencyTool,
  memberOverviewTool,
  memberVotingHistoryTool,
  memberInterestsTool,
  // debates
  searchHansardTool,
  getDebateTool,
  topicTrackerTool,
  // votes
  searchDivisionsTool,
  getDivisionTool,
  // bills, committees, government
  getBillTool,
  getCommitteeTool,
  getStateOfPartiesTool,
  getMinisterialRolesTool,
  getElectionResultsTool,
] as ToolDefinition[];

export const tools: ToolDefinition[] = compatTools(rawTools);
