import { ZONES } from "./config.js";

/** Slash command definitions, registered with `npm run register`. */

const STRING = 3,
  INTEGER = 4,
  USER = 6,
  MENTIONABLE = 9;

const taskOption = (description: string) => ({
  type: INTEGER,
  name: "task",
  description,
  required: true,
  autocomplete: true,
  min_value: 1,
});

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
    ],
  },
  {
    name: "done",
    description: "Mark a task as finished",
    ...guildOnly,
    options: [taskOption("Start typing to pick the task")],
  },
  {
    name: "edit-task",
    description: "Change a task's title, due date, details, or who it's assigned to",
    ...guildOnly,
    options: [
      taskOption("Start typing to pick the task"),
      { type: STRING, name: "task-name", description: "New title", max_length: 200 },
      { type: STRING, name: "due", description: "New due date", autocomplete: true },
      { type: STRING, name: "details", description: "New notes (type - to clear them)", max_length: 1000 },
      { type: MENTIONABLE, name: "who", description: "Reassign to someone else" },
    ],
  },
  {
    name: "delete-task",
    description: "Delete a task that's no longer needed",
    ...guildOnly,
    options: [taskOption("Start typing to pick the task")],
  },
];
