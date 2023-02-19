import { Plugin } from 'obsidian';

import { TaskGroup, TaskGroups } from 'Query/TaskGroup';
import type { Moment } from 'moment/moment';
import { Status } from 'Status';
import type { RRule } from 'rrule';
import { Query } from './Query/Query';
import { Cache, State } from './Cache';
import { Commands } from './Commands';
import { TasksEvents } from './TasksEvents';
import { initializeFile } from './File';
import { InlineRenderer } from './InlineRenderer';
import { newLivePreviewExtension } from './LivePreviewExtension';
import { QueryRenderer } from './QueryRenderer';
import { getSettings, updateSettings } from './Config/Settings';
import { SettingsTab } from './Config/SettingsTab';
import { StatusRegistry } from './StatusRegistry';
import { EditorSuggestor } from './Suggestor/EditorSuggestorPopup';
import { StatusSettings } from './Config/StatusSettings';

import { Recurrence } from './Recurrence';
import { Task } from './Task';
import { PriorityUtils } from './Task';
import { TaskRegularExpressions } from './Task';

import { DateFallback } from './DateFallback';
import { Lazy } from './lib/Lazy';

import { replaceTaskWithTasks } from './File';
import { dataset_dev } from 'svelte/internal';

import { TaskModal } from './TaskModal';

export class TaskUID {
    public readonly path: string; // file path
    public readonly sectionIndex: number; // which index
    public readonly taskIndex: number; // which task index in setion

    constructor(path: string, sectionIndex: number, taskIndex: number) {
        this.path = path;
        this.sectionIndex = sectionIndex;
        this.taskIndex = taskIndex;
    }

    public static fromTask(task: Task): TaskUID {
        return new TaskUID(task.path, task.sectionStart, task.sectionIndex);
    }
}

export class TaskExternal {
    public readonly isDone: Boolean;
    public readonly priority: number; // 1 is the highest priority, any larger number is a lower priority.

    public readonly tags: string[]; // a list of ASCII tags, distilled from the description.
    public readonly originalMarkdown: string; // the original markdown task.
    public readonly description: string; // the description of the task.
    public readonly estimatedTimeToComplete: number | null | undefined; // the estimated time to complete the task in minutes

    public readonly startDate: Moment | null;
    public readonly scheduledDate: Moment | null;
    public readonly dueDate: Moment | null;
    public readonly doneDate: Moment | null;

    public readonly uid: TaskUID;

    public readonly recurrenceRrule: RRule | null; ///< RRule as per the lib.
    
    /// The date after which the recurrence rule applies, may be
    ///  null if the RRule itself has a ref date,
    ///  ex) "every Monday".
    public readonly recurrenceReferenceDate: Moment | null;

    // TODO:
    // public readonly recurrence: Recurrence | null;
    constructor(task: Task) {
        this.isDone = task.status == Status.DONE; // TODO: enable more statuses.
        this.priority = PriorityUtils.toNumber(task.priority);
        this.tags = task.tags;
        this.originalMarkdown = task.originalMarkdown;
        this.startDate = task.startDate;
        this.scheduledDate = task.scheduledDate;
        this.dueDate = task.dueDate;
        this.doneDate = task.doneDate;
        this.description = task.description;
        this.estimatedTimeToComplete = task.estimatedTimeToComplete;
        this.recurrenceRrule = task.recurrence ? task.recurrence.rrule : null;
        this.recurrenceReferenceDate = task.recurrence ? task.recurrence.referenceDate : null;
        this.uid = TaskUID.fromTask(task);
    }
}

export default class TasksPlugin extends Plugin {
    private cache: Cache | undefined;
    public inlineRenderer: InlineRenderer | undefined;
    public queryRenderer: QueryRenderer | undefined;

    async onload() {
        console.log('loading plugin "tasks"');

        await this.loadSettings();
        this.addSettingTab(new SettingsTab({ plugin: this }));

        initializeFile({
            metadataCache: this.app.metadataCache,
            vault: this.app.vault,
        });

        // Load configured status types.
        await this.loadTaskStatuses();

        const events = new TasksEvents({ obsidianEvents: this.app.workspace });
        this.cache = new Cache({
            metadataCache: this.app.metadataCache,
            vault: this.app.vault,
            events,
        });
        this.inlineRenderer = new InlineRenderer({ plugin: this });
        this.queryRenderer = new QueryRenderer({ plugin: this, events });

        this.registerEditorExtension(newLivePreviewExtension());
        this.registerEditorSuggest(new EditorSuggestor(this.app, getSettings()));
        new Commands({ plugin: this });
    }

    async loadTaskStatuses() {
        const { statusSettings } = getSettings();
        StatusSettings.applyToStatusRegistry(statusSettings, StatusRegistry.getInstance());
    }

    onunload() {
        console.log('unloading plugin "tasks"');
        this.cache?.unload();
    }

    async loadSettings() {
        const newSettings = await this.loadData();
        updateSettings(newSettings);
        await this.loadTaskStatuses();
    }

    async saveSettings() {
        await this.saveData(getSettings());
    }

    public getTasks(): Task[] | undefined {
        return this.cache?.getTasks();
    }

    // HELPER NEEDED WHEN WRITING.

    // TODO: because we need to convert the TaskExternal to a Task, we kind of lose the benefit
    // of the whole TaskExeternal concept...
    public taskFromTaskExternal(taskExternal: TaskExternal | null): Task | null {
        if (!taskExternal) return null;

        const line = taskExternal.originalMarkdown;
        const regexMatch = line.match(TaskRegularExpressions.taskRegex);
        if (regexMatch === null) {
            return null;
        }

        const indentation = regexMatch[1];
        const listMarker = regexMatch[2];
        const body = regexMatch[4].trim();
        const blockLinkMatch = body.match(TaskRegularExpressions.blockLinkRegex);
        const blockLink = blockLinkMatch?.[0] ?? ''; // the real question is if there is an elvis operator.
        
        // Infer the scheduled date from the file name if not set explicitly
        const fallbackDate = DateFallback.fromPath(taskExternal.uid.path);
        let scheduledDate = taskExternal.scheduledDate;
        let scheduledDateIsInferred = false;
        if (DateFallback.canApplyFallback({
            startDate: taskExternal.startDate,
            scheduledDate: taskExternal.scheduledDate,
            dueDate: taskExternal.dueDate,
        }) && fallbackDate !== null) {
            scheduledDate = fallbackDate;
            scheduledDateIsInferred = true;
        }

        const recurrenceRule = body.match(TaskRegularExpressions.recurrenceRegex)?.[1]?.trim();
        let recurrence = recurrenceRule ? Recurrence.fromText({
            recurrenceRuleText: recurrenceRule,
            startDate: taskExternal.startDate,
            scheduledDate,
            dueDate: taskExternal.dueDate,
        }) : null;

        return new Task({
            estimatedTimeToComplete : taskExternal.estimatedTimeToComplete,
            status :taskExternal.isDone ? Status.DONE : Status.TODO, // TODO:
            description: taskExternal.description,
            path: taskExternal.uid.path,
            indentation,
            listMarker,
            sectionStart: taskExternal.uid.sectionIndex,
            sectionIndex: taskExternal.uid.taskIndex,
            precedingHeader: '', // TODO:
            priority: PriorityUtils.fromNumber(taskExternal.priority),
            startDate: taskExternal.startDate,
            scheduledDate,
            dueDate: taskExternal.dueDate,
            doneDate: taskExternal.doneDate,
            recurrence,
            blockLink,
            tags: taskExternal.tags,
            originalMarkdown: line,
            scheduledDateIsInferred,
        });
    }

    // PUBLIC WRITE INTERFACE.
    public async replaceTaskWithTasks(originalTask: Task, newTasks: Task[]) {
        return replaceTaskWithTasks({originalTask, newTasks});
    }

    // PUBLIC EDIT TASK INTERFACE.
    public editTaskWithModal(task: Task) : Promise<void> {
        return new Promise((resolve, reject) => {
            const onSubmit = (updatedTasks: Task[]): void => {
                replaceTaskWithTasks({
                    originalTask: task,
                    newTasks: DateFallback.removeInferredStatusIfNeeded(task, updatedTasks), // TODO: why?
                });
                resolve();
            };
            const taskModal = new TaskModal({
                app: this.app,
                task,
                onSubmit,
            });
            taskModal.open();
        });
    }

    // PUBLIC READ INTERFACE.
    public async oneHotResolveQueryToTasks(query: string): TaskExternal[] | undefined {
        return new Promise((resolve, reject) => {
            this.app.workspace.trigger(
                'obsidian-tasks-plugin:request-cache-update',
                ({ tasks, state }: { tasks: Task[]; state: State }) => {
                    let tasksExternal: TaskExternal[] = [];
                    const myQuery: Query = new Query({ source: query });
                    if (myQuery.error !== undefined) {
                        reject(myQuery.error);
                    }
                    if (state === State.Warm) {
                        const taskGroups: TaskGroups = myQuery.applyQueryToTasks(tasks);
                        // TODO: Currently this is a hack. we decompose the groups into a flat array for return.
                        // Should somehow return group information back as well.
                        taskGroups.groups.forEach((group: TaskGroup) => {
                            tasksExternal = tasksExternal.concat(
                                group.tasks.map((task: Task) => new TaskExternal(task)),
                            );
                        });
                    } else {
                        reject('Cache is not warm, but expected to be so.');
                    }
                    resolve(tasksExternal);
                },
            );
        });
    }
}

// NOTE: Let's figure out once and for all what the difference between let and var is.

// let = block scope.
// var is globally to the function regardless of block scope.
// var is also hoisted.
// let can only be accessed after it is declared.
// let is a declaration, var is a statement.

// javascript hositing is when the decl gets hoisted to the top of the scope (function scope).
function varTest() {
    var x = 1;
    {
        var x = 2; // same variable!
        console.log(x); // 2
    }
    console.log(x); // 2
}
// ^ silly example.
