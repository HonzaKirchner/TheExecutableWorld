/**
 * Field limits for an agent, shared by the form (client) and the action
 * (server). They come from Slack: the handle is the app's name as well as the
 * bot's display name, so the tighter of the two limits applies.
 */

/** display_information.name is capped at 35 characters (display_name at 80). */
export const HANDLE_MAX = 35;

/** display_information.description is capped at 140 characters. */
export const DESCRIPTION_MAX = 140;

export const INSTRUCTIONS_MAX = 4000;
