/**
 * The lengths the Worker holds a person to, shared so a form can say the rule before the
 * Worker refuses it. The Worker stays the authority: a form only uses these to say so first.
 */

/** The longest name a venture, project or milestone takes, in UTF-16 units after trimming. */
export const NAME_MAX = 120;

/** The longest a task's title may be, in UTF-16 units after trimming. A pasted list checks first. */
export const TASK_TITLE_MAX = 300;

/** The shortest password an account takes. */
export const PASSWORD_MIN = 10;
/** The longest password an account takes. */
export const PASSWORD_MAX = 256;

/** A password's length as the rule counts it: characters, after NFC. */
export const passwordLength = (pw: string): number => [...pw.normalize("NFC")].length;
