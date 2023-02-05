export class TaskExternal {
    public readonly isDone: Boolean;
    public readonly priority: number; // 1 is the highest priority, any larger number is a lower priority.

    public readonly tags: string[]; // a list of ASCII tags, distilled from the description.
    public readonly originalMarkdown: string; // the original markdown task.
    public readonly description: string; // the description of the task.

    public readonly startDate: Moment | null;
    public readonly scheduledDate: Moment | null;
    public readonly dueDate: Moment | null;
    public readonly doneDate: Moment | null;

    // TODO:
    // public readonly recurrence: Recurrence | null;
}
