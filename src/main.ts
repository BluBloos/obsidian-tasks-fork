import { Plugin } from 'obsidian';

import { TaskGroup, TaskGroups } from 'Query/TaskGroup';
import type { Moment } from 'moment/moment';
import { Status } from 'Status';
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
import type { Task } from './Task';
import { PriorityUtils } from './Task';

export class TaskExternal {
    public readonly isDone: Boolean;
    public readonly priority: number; // 1 is the highest priority, any larger number is a lower priority.

    public readonly tags: string[]; // a list of ASCII tags, distilled from the description.
    public readonly originalMarkdown: string; // the original markdown task.
    public readonly description: string; // the description of the task.
    public readonly estimatedTimeToComplete : number | null | undefined; // the estimated time to complete the task in minutes

    public readonly startDate: Moment | null;
    public readonly scheduledDate: Moment | null;
    public readonly dueDate: Moment | null;
    public readonly doneDate: Moment | null;

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
