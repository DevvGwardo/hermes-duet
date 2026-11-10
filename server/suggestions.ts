// Read-only connector discovery: pure heuristics over what is already configured. Nothing here installs,
// authorizes, or claims a connector exists; the hints are guidance the user follows by hand.
import type { Capabilities, Channel, Connector, ConnectorSuggestion } from '../shared/types';

export interface SuggestionsInput {
  /** "What I can see": the enabled toolsets and MCP server names Hermes reported. */
  capabilities?: Pick<Capabilities, 'apps' | 'toolsets'> | null;
  /** Native connector status, as served by /api/connectors. */
  connectors?: Pick<Connector, 'id' | 'kind' | 'status'>[] | null;
  /** The channels, so a channel that carries a repo can ask for GitHub tools. */
  channels?: Pick<Channel, 'repo'>[] | null;
}

/** At most three cards: a longer list is a chore to scan on a phone. */
const MAX_SUGGESTIONS = 3;

/** A native connector counts as connected only when it answered; a permission prompt is not a connection. */
function hasActive(connectors: SuggestionsInput['connectors'], kind: Connector['kind']): boolean {
  return (connectors ?? []).some((c) => (c.kind === kind || c.id === kind) && c.status === 'active');
}

/** Any GitHub-ish MCP app or toolset satisfies the repo heuristic, whatever it is called. */
function hasGithub(capabilities: SuggestionsInput['capabilities']): boolean {
  return [...(capabilities?.apps ?? []), ...(capabilities?.toolsets ?? [])].some((name) => /github/i.test(String(name ?? '')));
}

/**
 * What to connect next, in priority order: the two native bridges first, then the repo-specific GitHub
 * tools, then the generic MCP server. At most three are returned, and an install is never claimed.
 */
export function suggestedConnectors(input: SuggestionsInput = {}): ConnectorSuggestion[] {
  const out: ConnectorSuggestion[] = [];

  if (!hasActive(input.connectors, 'calendar')) {
    out.push({
      id: 'calendar',
      title: 'Connect Calendar',
      detail: 'See what is coming up and warn you before meetings start.',
      hint: 'macOS only: allow Hermes Duet to control Calendar in System Settings → Privacy & Security → Automation.',
    });
  }

  if (!hasActive(input.connectors, 'mail')) {
    out.push({
      id: 'mail',
      title: 'Connect Mail',
      detail: 'Read unread mail and draft replies for your approval.',
      hint: 'macOS only: allow Hermes Duet to control Mail in System Settings → Privacy & Security → Automation.',
    });
  }

  const repoChannels = (input.channels ?? []).filter((c) => String(c.repo ?? '').trim());
  if (repoChannels.length > 0 && !hasGithub(input.capabilities)) {
    out.push({
      id: 'github',
      title: 'Connect GitHub',
      detail: 'A channel points at a repository; connected GitHub tools let me read it and open drafts there.',
      hint: 'Add a GitHub MCP server under mcp_servers: in ~/.hermes/config.yaml and restart Hermes.',
    });
  }

  if ((input.capabilities?.apps ?? []).length === 0) {
    out.push({
      id: 'mcp',
      title: 'Connect an MCP server',
      detail: 'MCP servers give me tools for the apps and services you already use.',
      hint: 'Add a server under mcp_servers: in ~/.hermes/config.yaml and restart Hermes.',
    });
  }

  return out.slice(0, MAX_SUGGESTIONS);
}
