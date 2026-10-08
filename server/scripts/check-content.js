import { defaultPacks } from '../src/study.js';
const packs = await defaultPacks();
for (const pack of packs) console.log(`${pack.id} ${pack.version}: ${pack.review_status}${pack.reviewed_by ? `, ${pack.reviewed_by}, ${pack.reviewed_at}` : ' — editorial review pending'}`);
