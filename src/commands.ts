import { SETTINGS, ZONES } from "./config.js";

/** Slash command definitions, registered with `npm run register`. */

const STRING = 3,
  INTEGER = 4,
  BOOLEAN = 5,
  USER = 6,
  MENTIONABLE = 9;

const taskOption = (description = "Start typing to pick the task") => ({
  type: INTEGER,
  name: "task",
  description,
  required: true,
  autocomplete: true,
  min_value: 1,
});

/** who-2, who-3, ... up to SETTINGS.maxAssignees. */
const extraWho = Array.from({ length: Math.max(0, SETTINGS.maxAssignees - 1) }, (_, i) => ({
  type: MENTIONABLE,
  name: `who-${i + 2}`,
  description: "Also assign to this person or zone (shared task: anyone listed can complete it)",
}));

const guildOnly = { contexts: [0], integration_types: [0] };

export const COMMANDS = [
  {
    name: "assign",
    description: "Give someone on the e-board a task with a due date",
    ...guildOnly,
    options: [
      { type: MENTIONABLE, name: "who", description: "A person, or a zone role like @Finance Zone", required: true },
      { type: STRING, name: "task", description: "What needs to get done", required: true, max_length: 200 },
      {
        type: STRING,
        name: "due",
        description: "When it's due: friday, 10/3, next tuesday, in 2 weeks…",
        required: true,
        autocomplete: true,
      },
      ...extraWho,
      { type: STRING, name: "details", description: "Optional notes or links", max_length: 1000 },
    ],
  },
  {
    name: "tasks",
    description: "See open tasks (yours by default)",
    ...guildOnly,
    options: [
      { type: USER, name: "person", description: "Someone else's tasks" },
      {
        type: STRING,
        name: "zone",
        description: "Every open task in a zone",
        choices: [{ name: "Whole e-board", value: "all" }, ...ZONES.map((z) => ({ name: z.name, value: z.key }))],
      },
      { type: BOOLEAN, name: "overdue", description: "Only show overdue tasks" },
    ],
  },
  {
    name: "view-task",
    description: "See one task's details and history",
    ...guildOnly,
    options: [taskOption()],
  },
  {
    name: "done",
    description: "Mark a task complete",
    ...guildOnly,
    options: [taskOption()],
  },
  {
    name: "edit-task",
    description: "Change a task's title, due date, details, or who it's assigned to",
    ...guildOnly,
    options: [
      taskOption(),
      { type: STRING, name: "task-name", description: "New title", max_length: 200 },
      { type: STRING, name: "due", description: "New due date", autocomplete: true },
      { type: STRING, name: "details", description: "New notes (type - to clear them)", max_length: 1000 },
      { type: MENTIONABLE, name: "who", description: "Reassign: replaces everyone currently assigned" },
      ...extraWho.map((o) => ({ ...o, description: "Reassign: also assign to this person or zone" })),
    ],
  },
  {
    name: "cancel-task",
    description: "Cancel a task that's no longer needed (it stays in the history)",
    ...guildOnly,
    options: [taskOption(), { type: STRING, name: "reason", description: "Optional: why it was cancelled", max_length: 300 }],
  },
];
