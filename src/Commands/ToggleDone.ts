import { Editor, MarkdownView, View } from 'obsidian';
import { StatusRegistry } from '../StatusRegistry';

import { Task, TaskRegularExpressions } from '../Task';

/**
 * Caller must ensure it is accessing Editor atomically for the duration of the call.
 *
 * @param checking  If true, checks if toggling a Task is considered a valid action given the context
 *                  defined by params {@code editor} and {@code view}.
 * @param editor    An Obsidian Editor instance.
 * @param view      An Obsidian View instance.
 * @returns         A boolean if checking, otherwise undefined.
 */
export const toggleDone = (checking: boolean, editor: Editor, view: View): boolean | undefined => {
    if (checking) {
        if (!(view instanceof MarkdownView)) {
            // If we are not in a markdown view, the command shouldn't be shown.
            return false;
        }

        // The command should always trigger in a markdown view:
        // - Convert lines to list items.
        // - Convert list items to tasks.
        // - Toggle tasks' status.
        return true;
    }

    if (!(view instanceof MarkdownView)) {
        // Should never happen due to check above.
        return;
    }

    // We are certain we are in the editor due to the check above.
    const path = view.file?.path;
    if (path === undefined) {
        return;
    }

    const origCursorPos = editor.getCursor();
    const lineNumber = origCursorPos.line;
    const line = editor.getLine(lineNumber);

    const toggledLine = toggleLine(line);
    editor.setLine(lineNumber, toggledLine);

    /* Cursor positions are 0-based for both "line" and "ch" offsets.
     * If "ch" offset bigger than the line length, will just continue to next line(s).
     * By default "editor.setLine()" appears to either keep the cursor at the end of the line if it is already there,
     * ...or move it to the beginning if it is anywhere else. Licat explained this on Discord as "sticking" to one side or another.
     * Previously, Tasks would reset+move-right the cursor if there was any text in the line, including something inside the checkbox,
     * moving right by (toggledLine.length - line.length). (Supposedly, but it still moves right, just by less, if the toggledLine is shorter than the old).
     * This missed the need to move right on the blank line to "- " case (issue #460).
     * This also meant the cursor moved nonsensically if it was before any newly inserted text,
     * such as a done date at the end of the line, or after the ">" when "> -" changed to "> - [ ]".
     */
    // Reset the cursor. Use the difference in line lengths and original cursor position to determine behavior
    editor.setCursor({
        line: origCursorPos.line,
        ch: calculateCursorOffset(origCursorPos.ch, line, toggledLine),
    });
};

/**
 * Converts the string {@code line}, as if it was a single line in a file,
 * to as a Task, toggled, then rendered as a line again.
 *
 * @param line A line that may or may not represent a Task.
 * @returns    The {@code line}, interpreted as a Task, toggled, and rendered to a line again.
 */
export const toggleLine = (line: string) => {
    let toggledLine = line;

    const task = Task.fromLine({
        line,
        // such params below are only required for concrete Tasks that exist somewhere.
        // here, we merely use the Task class as a helper for its instance methods.
        path: '',
        sectionStart: 0,
        sectionIndex: 0,
        precedingHeader: null,
        fallbackDate: null,
    });
    if (task !== null) {
        // recall that tasks such as recurring tasks may produce more than one task as output.
        toggledLine = task
            .toggle()
            .map((task: Task) => task.toFileLineString())
            .join('\n');
    } else {
        // If the task is null this means that we have one of:
        // 1. a regular checklist item
        // 2. a list item
        // 3. a simple text line
        // 4. a standard task, but which does not contain the global filter, to be toggled, but no done date added.

        // The task regex will match checklist items.
        const regexMatch = line.match(TaskRegularExpressions.taskRegex);
        if (regexMatch !== null) {
            // Toggle the status of the checklist item.
            const statusString = regexMatch[3];
            const status = StatusRegistry.getInstance().bySymbol(statusString);
            const newStatusString = status.nextStatusSymbol;
            toggledLine = line.replace(TaskRegularExpressions.taskRegex, `$1- [${newStatusString}] $4`);
        } else if (TaskRegularExpressions.listItemRegex.test(line)) {
            // Convert the list item to a checklist item.
            toggledLine = line.replace(TaskRegularExpressions.listItemRegex, '$1$2 [ ]');
        } else {
            // Convert the line to a list item.
            toggledLine = line.replace(TaskRegularExpressions.indentationRegex, '$1- ');
        }
    }

    return toggledLine;
};

/* Cases (another way):
0) Line got shorter: done date removed from end of task, cursor should reset or be moved to new end if reset position is too long.
1) Line stayed the same length: Checking & unchecking textbox that is not a task - cursor should reset.
2) Line got longer:
    a) List marker could have been added. Find it in new text: if cursor was at or right of where it was added, move the cursor right.
    b) Empty checkbox could have been added. If cursor was after the list marker (in old or new), it should move right.
    c) Done emoji and date could have been added to the end. Cursor should reset if 0, and stay end of line otherwise.
    d) Recurring task could have been added to the beginning and done emoji and date added to the end. Current behavior adds so much to the offset to make this right.

So cursor should be reset if 0, which includes being moved to new end if got shorter. Then might need to move right 2 or 3.
*/
export const calculateCursorOffset = (origCursorCh: number, line: string, toggledLine: string) => {
    let newLineLen = toggledLine.length;
    if (newLineLen <= line.length) {
        // Line got shorter or stayed same length. Reset cursor to original position, capped at end of line.
        return origCursorCh >= toggledLine.length ? newLineLen : origCursorCh;
    }

    // Special-case for done-date append, fixes #449
    const doneDateLength = ' ✅ YYYY-MM-DD'.length;
    if (toggledLine.match(TaskRegularExpressions.doneDateRegex) && newLineLen - line.length >= doneDateLength) {
        newLineLen -= doneDateLength;
    }

    // Handle recurring tasks: entire line plus newline prepended. Fix for #449 above means appended done date treated correctly.
    if (newLineLen >= 2 * line.length && toggledLine.search('.+\n.+') !== -1) {
        return origCursorCh + newLineLen - line.length;
    }

    /* Line got longer, not a recurring task. Were the added characters before or after the cursor?
     * At this point the line is at least a list item. Find the first list marker. */
    const firstListItemChar = toggledLine.search(/[-*]/);
    if (origCursorCh < firstListItemChar) {
        // Cursor was in indentation. Reset to where it was.
        return origCursorCh;
    }

    return origCursorCh + newLineLen - line.length;
};
