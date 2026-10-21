import type { Chapter } from '../types';

export const gettingAround: Chapter = {
  id: 'getting-around',
  title: 'Getting around',
  content: `## Getting around Listen-Fire

Listen-Fire is organised as a set of pages reached from the left sidebar. Use
the **exact label shown in the sidebar** when you tell someone where to
go (the route is given for reference). Here is what each one is for.

- **Home** (\`/\`) — the starting overview.
- **Automations** (\`/automations\`) — your automations: what they do and
  their recent runs.
- **Credentials** (\`/credentials\`) — every integration and account you
  have connected: CRMs, email, and the rest. This is where you add a new
  integration (see the "Connecting integrations" chapter). It is **not**
  under Settings.
- **Adapters** (\`/adapters\`) — the catalogue of systems Listen-Fire can read
  from and write to, and what each can do.
- **Plugins** (\`/plugins\`) — reusable transform steps an automation can import.
- **Library** (\`/library\`) — the handbooks (including this one).
- **Data model** (\`/model\`) — the knowledge model: the entity types,
  fields, and relationships Listen-Fire tracks for you (the "Knowledge Graph"
  section of the sidebar). The entity types appear as sub-items beneath it.
- **API Explorer** (\`/api-explorer\`) — browse the API.
- **Settings** (\`/settings\`) — account-level settings, with tabs for
  General, API Keys, OAuth Clients, Webhooks, and Remote Adapters.
  Connecting third-party integrations is **not** here — that's Credentials.

When a user asks "where do I…", answer with the sidebar label above and
its route. If you are unsure a page still exists, say where it was rather
than inventing a new one.

### a-shareable-picture

Every automation carries a picture — a link anyone holding it can open to see
its structure: what starts it, the steps it runs, and the records it touches.
Holding the link is enough to view it; no login is required, and opening it
changes nothing. It shows structure only, never what a run has actually
captured or written, and it lives only as long as the automation it pictures —
delete the automation and the link goes with it (it can also be revoked on its
own, without deleting anything).`,
};
