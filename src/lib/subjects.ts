// Suggests a subject for an upload from its file name or title.

const RULES: [RegExp, string][] = [
  [/anatom|histolog|embryolog/i, 'Anatomy'],
  [/physiolog/i, 'Physiology'],
  [/biochem|metabol/i, 'Biochemistry'],
  [/pharmac|drug/i, 'Pharmacology'],
  [/microbio|bacteriolog|virolog/i, 'Microbiology'],
  [/immunolog/i, 'Immunology'],
  [/patholog/i, 'Pathology'],
  [/obstetric|gynecolog|gynaecolog/i, 'Obstetrics & Gynecology'],
  [/pediatric|paediatric/i, 'Pediatrics'],
  [/neurolog/i, 'Neurology'],
  [/psychiatr/i, 'Psychiatry'],
  [/surger|surgical/i, 'Surgery'],
  [/internal medicine|general medicine|clinical medicine/i, 'Medicine'],
];

export function suggestSubject(text: string): string | null {
  if (!text) return null;
  for (const [pattern, subject] of RULES) {
    if (pattern.test(text)) return subject;
  }
  return null;
}
