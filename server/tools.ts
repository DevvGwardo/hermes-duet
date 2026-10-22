// Tool contract between the agent and Hermes Duet. The MCP shim lists these; the server executes them.

const taskId = { type: 'string', description: 'The Hermes Duet task id this belongs to, if you are working on a task (it appears in your instructions as "Hermes Duet task <id>").' };

export const TOOLS = [
  {
    name: 'request_approval',
    description:
      'Ask the user to approve a sensitive action BEFORE you take it: sending a message or email as them, paying or spending money, deleting things, posting publicly, signing, or anything hard to undo. ' +
      'This posts an Approve / Not now card on their phone and returns immediately; it does NOT wait. After calling it, do not perform the action: tell the user in one short line what you are waiting on and end your turn. ' +
      'When they decide, you will receive a new message starting with "[approval <card_id>]" saying APPROVED, APPROVED with edits (followed by the text to send instead of your draft), or NOT NOW, and only then do you act.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Send the reply to Dana" or "Pay the $640 health permit".' },
        summary: { type: 'string', description: 'Markdown shown on the card: exactly what will happen (recipient, channel, amount). When you pass draft, do not repeat the draft text here.' },
        draft: {
          type: 'string',
          description:
            'For messages, emails and posts: the exact text you will send, as plain text without headers. The user can edit it on the card; if they do, the APPROVED message contains their version and you must send that text exactly.',
        },
        action_label: { type: 'string', description: 'Primary button verb, e.g. "Send", "Pay $640", "Delete". Default "Approve".' },
        replaces: {
          type: 'string',
          description:
            'When this redrafts an approval that is still waiting (the user asked for changes in chat instead of tapping), the card_id of that earlier card. It is withdrawn so the old version can no longer be approved.',
        },
        task_id: taskId,
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'ask',
    description:
      'Ask the user a quick question with 2-4 tappable answers when you need a decision to continue. Returns immediately; end your turn after asking. ' +
      'Their answer arrives as a new message starting with "[answer <card_id>]".',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
        context: { type: 'string', description: 'Optional markdown with the background needed to answer.' },
        replaces: { type: 'string', description: 'The card_id of an earlier question still waiting that this one supersedes. It is withdrawn so it can no longer be answered.' },
        task_id: taskId,
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'post_brief',
    description:
      'Post a brief: a short ranked list of decisions that need the user (used for the morning brief and check-ins), plus an optional Watching list. ' +
      'entries are decisions only, at most 5 (the server sorts them high to low and moves any extra to Watching); each is one line, a short detail, and the draft you already prepared if there is one. ' +
      'watching is for things you are keeping an eye on that need no decision yet; it is shown muted and never notifies. ' +
      'It posts a card and notifies the user, so a check-in needs at least one entry; if nothing needs a decision, do not call it then. ' +
      'The morning brief is the exception: on a quiet day, call it with no entries and a non-empty watching list; it posts without notifying.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'e.g. "Good morning. 3 things need you today." Count decisions only; the server corrects the number (with none, it reads "Nothing needs you today").' },
        summary: { type: 'string', description: 'Optional one or two sentences of markdown above the list.' },
        entries: {
          type: 'array',
          description: 'Decisions. At least one, except in the morning brief, which may send none if watching is non-empty.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              action_label: { type: 'string', description: 'Optional button, e.g. "Draft a reply", or "Send it" on an entry with a draft.' },
              action_message: { type: 'string', description: 'For an entry without a draft: what tapping the button sends to you as the user, e.g. "Draft a reply to Dana about the lease".' },
              draft: {
                type: 'string',
                description:
                  'Markdown you already prepared for this decision, e.g. the full reply to Dana. Shown collapsed under the entry. Nothing is sent. ' +
                  'The entry then gets a button (action_label, default "Send as drafted") that hands this exact draft back to you to go ahead with; for anything outward-facing you then call request_approval with it.',
              },
            },
            required: ['title'],
          },
        },
        watching: {
          type: 'array',
          description: 'Optional. Things you are tracking that need no decision yet, e.g. "Package arrives Thursday". Muted, never notifies.',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, detail: { type: 'string' } },
            required: ['title'],
          },
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'post_card',
    description:
      'Show structured progress or results as a card in the thread. type "checklist" for multi-step plans (pass all items with done flags), "metrics" for a small dashboard of numbers, "note" for anything else. ' +
      'Pass card_id from a previous call to update that card in place instead of posting a new one (do this as checklist items get done).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['checklist', 'metrics', 'note'] },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown.' },
        checklist: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } },
        metrics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              delta: { type: 'string', description: 'e.g. "+12% wk"' },
              tone: { type: 'string', enum: ['good', 'bad', 'neutral'] },
            },
            required: ['label', 'value'],
          },
        },
        card_id: { type: 'string', description: 'Update this existing card instead of creating one.' },
        task_id: taskId,
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'deliver_file',
    description:
      'Hand the user a finished deliverable (doc, spreadsheet, deck, dashboard, image, PDF). Write the file to disk first, then call this with its absolute path. ' +
      'HTML files render live on their phone, so a self-contained .html is the best format for dashboards and decks; .md renders as a document.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        title: { type: 'string', description: 'Human title, e.g. "Q3 investor update deck".' },
        summary: { type: 'string', description: 'One or two lines on what it is and what to look at.' },
        task_id: taskId,
      },
      required: ['path', 'title'],
    },
  },
  {
    name: 'save_page',
    description:
      'Make a delivered file a standing page: something the user checks every morning (e.g. "build me one page I can check every morning"). ' +
      'Build and deliver the first version with deliver_file, then call this with the file id it returned and instructions for rebuilding the page. ' +
      'Every day, 30 minutes before the morning brief, Hermes Duet runs those instructions as a background task that delivers a fresh version in place of the old one. ' +
      'Pass page_id to change an existing page, or page_id with remove: true when the user no longer wants it.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The file id deliver_file returned for the current version.' },
        title: { type: 'string', description: 'Short page name, e.g. "Morning dashboard".' },
        instructions: {
          type: 'string',
          description:
            'Self-contained instructions for rebuilding it from scratch each morning: the sources to read, the sections and layout, the file format, and what to compare against the previous version. The refresh runs in a fresh session that knows nothing else.',
        },
        page_id: { type: 'string', description: 'An existing page to update or remove.' },
        remove: { type: 'boolean', description: 'With page_id: stop refreshing that page. Its files stay in the Make tab.' },
        task_id: taskId,
      },
      required: [],
    },
  },
  {
    name: 'start_task',
    description:
      'Start a larger piece of work in the background (research, building a deck/model/dashboard, multi-step errands) so the conversation stays free. ' +
      'It runs in its own session with its own context, so the instructions must be complete and self-contained. Returns a task id; the user sees it in their Tasks tab. When it finishes, the user gets a handover card in the thread (result, delivered files, follow-ups), and you get a note with the result alongside their next message.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task name shown in the Tasks tab.' },
        instructions: { type: 'string', description: 'Everything the background worker needs: goal, context, constraints, what to deliver.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Optional planned steps.' },
      },
      required: ['title', 'instructions'],
    },
  },
  {
    name: 'update_task',
    description: 'Update a Hermes Duet task\'s progress line, steps or status so the user can see where it stands.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        progress: { type: 'string', description: 'One line: what you are doing now.' },
        steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } },
        status: { type: 'string', enum: ['running', 'waiting', 'done', 'failed'] },
        result: { type: 'string', description: 'Final outcome, when done or failed (for failed, the reason). One or two lines; it is the body of the handover card.' },
        changed: {
          type: 'string',
          description: 'Standing page refreshes only: one line on the single most important thing that changed since the previous version ("No change since yesterday" if nothing did).',
        },
        follow_ups: {
          type: 'array',
          maxItems: 3,
          description: 'Up to three one-tap next steps shown on the handover card when the task is done.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button text, e.g. "Draft the email".' },
              message: {
                type: 'string',
                description: 'What tapping sends to the main conversation as the user. That conversation only knows the task title and result, so make it self-contained.',
              },
            },
            required: ['label', 'message'],
          },
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'notify',
    description:
      'Send a push notification to the user\'s phone. It also posts as a note card in the thread, which the notification opens. Only for things that genuinely need them soon; cards from request_approval / ask already notify, and briefs notify on their own. Not available in check-ins or the morning brief: use post_brief there.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];
