/** Public, original draft example. No private course or uploaded-book data. */
export const STUDY_PREVIEW = {
  title: 'Follow the blood flow',
  lesson: 'Start with the destination. The right ventricle sends blood toward the lungs through the pulmonary trunk, which branches into the pulmonary arteries. Blood returns from the lungs to the left atrium through pulmonary veins. The left ventricle then sends it through the aorta to the body. Arteries carry blood away from the heart; veins carry it toward the heart.',
  route: ['Right ventricle', 'Pulmonary trunk', 'Lungs'],
  question: 'In normal adult circulation, which vessel receives blood directly from the right ventricle?',
  options: ['The aorta', 'The pulmonary trunk', 'A pulmonary vein', 'The superior vena cava'],
  correctIndex: 1,
  explanation: 'The pulmonary trunk takes right ventricular output toward the lungs. The aorta receives blood from the left ventricle; pulmonary veins return blood to the left atrium. The superior vena cava returns blood from the upper body to the right atrium.',
  repairs: [
    'The aorta is the outlet of the left ventricle. For the right ventricle, follow the route toward the lungs: right ventricle → pulmonary trunk.',
    '',
    'Pulmonary veins return blood from the lungs to the left atrium. They do not carry blood out of the right ventricle.',
    'The superior vena cava returns blood to the right atrium. It comes before the right ventricle on that path, rather than carrying blood out of it.',
  ],
  sources: [{
    title: 'OpenStax Anatomy and Physiology 2e: Heart Anatomy',
    url: 'https://openstax.org/books/anatomy-and-physiology-2e/pages/19-1-heart-anatomy',
    section: '19.1 — Chambers and Circulation through the Heart',
  }],
};
