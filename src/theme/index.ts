// Athena's visual theme — a calm, dark, medical palette (teal + deep navy).

export const colors = {
  background: '#0B1220',
  surface: '#111A2C',
  surfaceAlt: '#182338',
  border: '#233150',
  text: '#F1F5F9',
  textMuted: '#94A3B8',
  primary: '#2DD4BF',
  primaryDark: '#0D9488',
  primaryText: '#04241F',
  accent: '#38BDF8',
  danger: '#F87171',
  dangerSurface: '#391D27',
  dangerText: '#FECACA',
  warning: '#FBBF24',
  success: '#4ADE80',
  white: '#FFFFFF',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 26,
  xxl: 34,
} as const;

const SUBJECT_COLORS: Record<string, string> = {
  Anatomy: '#F472B6',
  Physiology: '#2DD4BF',
  Biochemistry: '#FBBF24',
  Pharmacology: '#A78BFA',
  Microbiology: '#34D399',
  Pathology: '#F87171',
  Immunology: '#FB923C',
  Medicine: '#38BDF8',
  Surgery: '#FB7185',
  Pediatrics: '#FACC15',
  'Obstetrics & Gynecology': '#E879F9',
  Neurology: '#818CF8',
  Psychiatry: '#4ADE80',
  General: '#94A3B8',
};

export const SUBJECT_SUGGESTIONS = Object.keys(SUBJECT_COLORS);

export function getSubjectColor(subject: string | null | undefined): string {
  if (!subject) return colors.accent;
  return SUBJECT_COLORS[subject] ?? colors.accent;
}

/** Appends an alpha channel to a 6-digit hex color (for tinted backgrounds). */
export function withAlpha(hex: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alphaHex}` : colors.surfaceAlt;
}
