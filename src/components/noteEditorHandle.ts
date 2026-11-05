/** Shared editor commands. Importing this type never loads the rich editor. */
export interface MdxNoteEditorHandle {
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  insertMarkdown: (markdown: string) => void;
  getSelectionMarkdown: () => string;
  focus: () => void;
  scrollToHeading?: (heading: string) => boolean;
}
