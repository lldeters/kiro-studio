/**
 * What goes into a prompt besides the user's text. The shapes follow ACP's content blocks; they are defined here so
 * that the layers above do not need the SDK's types.
 */

export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text: string } };

export interface PromptInput {
  text: string;
  /** Blocks sent after the text. */
  blocks?: PromptBlock[];
  /** Short names of the attachments, shown with the user's message in the transcript. */
  labels?: string[];
}
