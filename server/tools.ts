// Tool contract between the agent and Hermes Duet. The MCP shim lists these; the server executes them.

const taskId = { type: 'string', description: 'The Hermes Duet task id this belongs to, if you are working on a task (it appears in your instructions as "Hermes Duet task <id>").' };

export const TOOLS = [
  {
    name: 'request_approval',
    description:
      'Ask the user to approve a sensitive action BEFORE you take it: sending a message or email as them, paying or spending money, deleting things, posting publicly, signing, or anything hard to undo. ' +
      'This posts an Approve / Not now card on their phone and returns immediately; it does NOT wait. After calling it, do not perform the action: tell the user in one short line what you are waiting on and end your turn. ' +
      'When they decide, you will receive a new message starting with "[approval <card_id>]" saying APPROVED or NOT NOW, and only then do you act.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Send the reply to Dana" or "Pay the $640 health permit".' },
        summary: { type: 'string', description: 'Markdown shown on the card: exactly what will happen, including the full draft text for messages.' },
        action_label: { type: 'string', description: 'Primary button verb, e.g. "Send", "Pay $640", "Delete". Default "Approve".' },
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
        task_id: taskId,
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'post_brief',
    description:
      'Post a brief: a short prioritized list of what needs the user\'s attention (used for the morning brief and check-ins). Keep it to the 3-7 items that matter; each item is one line plus a short detail. ' +
      'It posts a card and notifies the user, so it needs at least one entry; if nothing needs them, do not call it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'e.g. "Good morning. 4 things need you today."' },
        summary: { type: 'string', description: 'Optional one or two sentences of markdown above the list.' },
        entries: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              action_label: { type: 'string', description: 'Optional button, e.g. "Draft a reply".' },
              action_message: { type: 'string', description: 'What tapping the button sends to you as the user, e.g. "Draft a reply to Dana about the lease".' },
            },
            required: ['title'],
          },
        },
      },
      required: ['title', 'entries'],
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
        result: { type: 'string', description: 'Final outcome, when done or failed. One or two lines; it is the body of the handover card.' },
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
      'Send a push notification to the user\'s phone. Only for things that genuinely need them soon; cards from request_approval / ask already notify, and briefs notify on their own.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];
