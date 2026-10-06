// Shared highlight palette — used by the reader tint picker, the notes
// drawer dots and the "My notes" screen.

export const HIGHLIGHT_COLOR_KEYS = ['gold', 'blue', 'green', 'pink'] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLOR_KEYS)[number];

/** Solid dot colors (tints are theme-aware and live in the reader). */
export const HIGHLIGHT_DOTS: Record<HighlightColor, string> = {
  gold: '#D2921F',
  blue: '#6D8BFF',
  green: '#34C77B',
  pink: '#E878AA',
};
