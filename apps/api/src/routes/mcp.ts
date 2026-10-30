import { Hono } from 'hono';
import { notImplemented } from '../lib/router';
import type { AppEnv } from '../lib/types';

/** MCP streamable HTTP endpoint. The agent lane serves `agentTools` here. */
export const mcpRoutes = new Hono<AppEnv>().all('/mcp', (c) => notImplemented(c, 'MCP server')).all('/mcp/*', (c) => notImplemented(c, 'MCP server'));
