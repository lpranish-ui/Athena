export const fixturePack = {
  id: 'cardiovascular-foundations', title: 'Cardiovascular foundations', subject: 'Physiology',
  description: 'Fixture course', version: 'test-1', review_status: 'draft', review_note: 'Unreviewed teaching sample.',
  concepts: ['flow', 'preload', 'afterload', 'cycle'].map((id) => ({
    id, title: id, objective: `Explain ${id}`, lesson: `A short ${id} lesson.`,
    key_points: ['First principle'], estimated_minutes: 3,
    sources: [{ title: 'Open teaching source', url: 'https://example.org/source', section: id }],
    questions: [0, 1, 2].map((index) => ({ id: `${id}-q${index}`, prompt: `${id} variant ${index}?`,
      options: ['Correct', 'Wrong 1', 'Wrong 2', 'Wrong 3'], correct_index: 0,
      explanation: `${id} explanation`, misconceptions: ['Correct principle', 'Confuses mechanisms', 'Confuses units', 'Confuses timing'] })),
  })),
};
