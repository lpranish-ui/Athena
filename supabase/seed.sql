-- ============================================================================
-- Athena — seed data: the built-in demo books
-- ============================================================================
-- How to apply: Supabase Dashboard → SQL Editor → paste → Run.
-- (Run AFTER 0001_init.sql. Safe to run multiple times.)
--
-- These two books contain short original study summaries written for the
-- Athena demo library. They are intentionally brief: upload your own books
-- (or import open-access textbooks) for full-length content.
-- Always verify any medical information against your official textbooks.
-- ============================================================================

-- ── Book 1: Cardiovascular Essentials ────────────────────────────────────────
insert into public.books (id, title, author, subject, description, cover_color, is_default, license, license_url)
values (
  'b0000001-0000-4000-8000-000000000000',
  'Cardiovascular Essentials',
  'Athena Demo Library',
  'Physiology',
  'A short introductory tour of the heart, the cardiac cycle and blood pressure regulation. Generate MCQs from any chapter to try Athena''s AI quiz builder.',
  '#14B8A6',
  true,
  'Athena original content — free to use in this app',
  null
)
on conflict (id) do nothing;

insert into public.chapters (id, book_id, number, title, content)
values
(
  'c0000001-0000-4000-8000-000000000001',
  'b0000001-0000-4000-8000-000000000000',
  1,
  'The Heart: Structure and Function',
  $ch$
The heart is a four-chambered muscular pump that sits in the mediastinum of the thorax. Its pointed apex is formed by the left ventricle and projects downward, forward and to the left, typically reaching the fifth intercostal space at the midclavicular line.

The heart wall has three layers. The epicardium is the thin outer layer; the myocardium is the thick middle layer of cardiac muscle that performs the pumping work; and the endocardium is the smooth inner lining that is continuous with the endothelium of the blood vessels. The whole organ is enclosed in the pericardium: a tough fibrous outer sac and a serous inner sac whose two layers (parietal and visceral) glide over each other, lubricated by a thin film of pericardial fluid.

The right side of the heart handles deoxygenated blood, and the left side handles oxygenated blood. The right atrium receives blood from the superior and inferior venae cavae; the right ventricle pumps it through the pulmonary valve into the pulmonary trunk toward the lungs. The left atrium receives oxygenated blood from the four pulmonary veins; the left ventricle pumps it through the aortic valve into the aorta to the systemic circulation. The left ventricle has the thickest myocardium because it must generate far higher pressures than the right side.

There are four valves, all one-way. Atrioventricular valves separate atria from ventricles: the tricuspid (three cusps) on the right and the mitral or bicuspid (two cusps) on the left. They are anchored by chordae tendineae, which attach to papillary muscles that contract during systole to prevent the cusps from prolapsing into the atria. The semilunar valves (pulmonary and aortic) have three cusps each and sit at the outlets of the ventricles.

The heart muscle itself is supplied by the coronary arteries. The left coronary artery divides into the left anterior descending and circumflex arteries, while the right coronary artery supplies the right side and, in most people, the posterior descending territory. Cardiac veins drain into the coronary sinus, which empties into the right atrium.

The heartbeat originates in the conduction system. The sinoatrial node in the right atrium is the natural pacemaker, firing at roughly 60–100 times per minute. Impulses spread through the atria to the atrioventricular node, where conduction slows, allowing the atria to finish filling the ventricles. The signal then races down the bundle of His, the right and left bundle branches, and the Purkinje fibers, reaching an intraventricular conduction speed of 2–4 m/s. Intrinsic rates fall along the way: the AV node can pace at 40–60 per minute and Purkinje fibers at 20–40 per minute if the SA node fails.

Autonomic nerves tune the pump. Sympathetic stimulation (norepinephrine acting on beta-1 receptors) increases heart rate, conduction speed and contractility, while parasympathetic vagal activity (acetylcholine on muscarinic M2 receptors) slows the SA node and AV conduction.

Cardiac output is the volume of blood pumped by each ventricle per minute: cardiac output = heart rate × stroke volume. Stroke volume is end-diastolic volume minus end-systolic volume, and it is governed by preload (the degree of ventricular filling), afterload (the resistance the ventricle must eject against) and contractility (the intrinsic strength of the muscle). The two heart sounds are valve closures: S1 is closure of the mitral and tricuspid valves at the start of systole, and S2 is closure of the aortic and pulmonary valves at the end of systole.

Key points:
- The left ventricle has the thickest wall; the apex is formed by the left ventricle.
- Tricuspid and mitral valves are anchored by chordae tendineae and papillary muscles.
- The SA node (60–100/min) → AV node (delay) → bundle of His → bundle branches → Purkinje fibers.
- Sympathetic input uses beta-1 receptors and speeds the heart; vagal input uses M2 receptors and slows it.
- Cardiac output = heart rate × stroke volume; stroke volume depends on preload, afterload and contractility.
- S1 = AV valve closure; S2 = semilunar valve closure.
  $ch$
),
(
  'c0000001-0000-4000-8000-000000000002',
  'b0000001-0000-4000-8000-000000000000',
  2,
  'The Cardiac Cycle',
  $ch$
The cardiac cycle is the sequence of electrical and mechanical events from the beginning of one heartbeat to the beginning of the next. At a resting rate of about 75 beats per minute, one cycle lasts roughly 0.8 seconds, of which atrial systole occupies about 0.1 s and ventricular systole about 0.3 s, leaving roughly 0.4 s of diastole.

The cycle begins with atrial systole. The atria contract and top up the ventricles with the final portion of blood — often called the atrial kick — accounting for roughly 20% of ventricular filling at rest. The P wave on the ECG corresponds to atrial depolarization just before this contraction.

Next is isovolumetric ventricular contraction. As ventricular pressure rises above atrial pressure, the atrioventricular valves snap shut, producing the first heart sound (S1). For a brief moment all four valves are closed and pressure builds with no change in volume — an isovolumetric phase. On the ECG this is just after the QRS complex, which represents ventricular depolarization.

When ventricular pressure exceeds the pressure in the aorta and pulmonary trunk, the semilunar valves open and ejection begins. Rapid ejection is followed by a slower reduced-ejection phase as the ventricles approach the end of systole with about 50 mL remaining (end-systolic volume). The T wave marks ventricular repolarization during this period.

The cycle continues with isovolumetric relaxation. Ventricular pressure drops below the pressure in the great arteries, and the semilunar valves close — the second heart sound (S2). The small transient pressure bump in the aorta at this moment is the dicrotic notch. With the AV valves still shut, the ventricles relax without changing volume.

Finally, when ventricular pressure falls below atrial pressure, the AV valves open and rapid ventricular filling begins — most filling is passive, driven by the pressure gradient. A slower filling phase (diastasis) follows until the next atrial contraction restarts the cycle.

Typical resting pressures worth remembering: left ventricle about 120/8 mmHg, aorta about 120/80 mmHg, left atrium about 12/8 mmHg and right atrium about 4/0 mmHg. Typical volumes: end-diastolic volume about 120 mL, end-systolic volume about 50 mL, giving a stroke volume of about 70 mL and an ejection fraction of 55–70%, calculated as stroke volume ÷ end-diastolic volume.

Valve problems distort the cycle in characteristic ways. A narrowed valve (stenosis) forces the upstream chamber to generate higher pressure, producing murmurs during flow. A leaky valve (regurgitation) allows backward flow, producing murmurs when the valve should be closed — for example, the pansystolic murmur of mitral regurgitation or the early-diastolic murmur of aortic regurgitation.

Key points:
- One cycle ≈ 0.8 s at 75 bpm: atrial systole 0.1 s, ventricular systole 0.3 s, diastole 0.4 s.
- S1 = AV valves closing at the start of isovolumetric contraction; S2 = semilunar valves closing at the start of isovolumetric relaxation.
- ECG order: P wave → atrial systole; QRS → ventricular systole begins; T wave → repolarization during ejection.
- EDV ≈ 120 mL, ESV ≈ 50 mL, stroke volume ≈ 70 mL, ejection fraction 55–70%.
- During isovolumetric phases all four valves are closed and the chamber volume does not change.
  $ch$
),
(
  'c0000001-0000-4000-8000-000000000003',
  'b0000001-0000-4000-8000-000000000000',
  3,
  'Blood Pressure and Its Regulation',
  $ch$
Arterial blood pressure is the lateral pressure exerted by blood on the walls of the arteries. It is written as systolic pressure over diastolic pressure — typically about 120/80 mmHg at rest in a healthy young adult. Pulse pressure is the difference between systolic and diastolic pressure, and mean arterial pressure (MAP) is approximately diastolic pressure plus one third of the pulse pressure, because the heart spends roughly twice as long in diastole as in systole at rest.

Blood pressure depends on two main hemodynamic variables: cardiac output and systemic vascular resistance. To a first approximation, MAP ≈ cardiac output × systemic vascular resistance. Arterial compliance and total blood volume also influence the pressure for any given flow. Because of this relationship, blood pressure can fall either because the heart pumps less blood or because the vessels dilate, and it can rise because output increases, resistance increases, or volume is retained.

The fastest control system is the baroreceptor reflex. Stretch-sensitive nerve endings in the carotid sinuses and the aortic arch continuously monitor arterial pressure. Signals travel through the glossopharyngeal nerve (cranial nerve IX) from the carotid sinus and the vagus nerve (cranial nerve X) from the aortic arch to the nucleus tractus solitarius in the medulla. When pressure rises, the reflex increases parasympathetic output to the heart and reduces sympathetic output to the heart and blood vessels, lowering heart rate, contractility and vascular tone. When pressure falls, the opposite happens. The reflex buffers moment-to-moment changes, such as those occurring when standing up, and it resets over time to the prevailing pressure level.

The renin–angiotensin–aldosterone system provides intermediate and long-term regulation. When the juxtaglomerular cells of the kidney sense reduced renal perfusion, they release renin, which converts angiotensinogen to angiotensin I. Angiotensin-converting enzyme in the lungs converts it to angiotensin II, a powerful vasoconstrictor that also stimulates aldosterone secretion, antidiuretic hormone release and thirst. Aldosterone increases sodium and water reabsorption in the distal nephron, expanding blood volume; antidiuretic hormone concentrates the urine and adds vasoconstriction. Together they restore pressure mainly by restoring volume.

Atrial natriuretic peptide is the main counter-regulatory hormone: when the atria are stretched by volume overload, they release ANP, which promotes sodium and water excretion, dilates vessels and opposes the renin–angiotensin system. Local control mechanisms also matter — arterioles dilate in response to metabolic signals such as adenosine, carbon dioxide and potassium accumulation — matching local blood flow to tissue demand without involving central reflexes.

Over the very long term, arterial pressure tracks the kidney''s handling of sodium and water: the body defends its extracellular fluid volume around a balance point at which pressure drives exactly enough sodium and water excretion to match intake. This is why chronic kidney disease so often causes sustained hypertension.

Blood pressure is measured with a cuff and a stethoscope: the cuff is inflated above systolic pressure and slowly deflated, and the Korotkoff sounds mark systolic pressure at their first appearance and diastolic pressure at their disappearance. Sustained values of 140/90 mmHg or above define hypertension in the classic threshold, although modern guidelines are stricter; persistent low values with symptoms suggest hypotension. Remember that a single reading can be misleading — white-coat and masked hypertension are both common — so diagnosis relies on repeated measurements.

Key points:
- MAP ≈ cardiac output × systemic vascular resistance; pulse pressure = systolic − diastolic.
- The baroreceptor reflex is the fast buffer: carotid sinus (CN IX) and aortic arch (CN X) → nucleus tractus solitarius → altered sympathetic and vagal output.
- Renin → angiotensin I → angiotensin II (via ACE): vasoconstriction plus aldosterone, ADH and thirst — the main volume-restoring axis.
- ANP opposes RAAS by promoting natriuresis and vasodilation.
- Long-term blood pressure is set by renal sodium and water balance.
- Korotkoff sounds: first sound ≈ systolic pressure; last sound ≈ diastolic pressure.
  $ch$
)
on conflict (id) do nothing;

-- ── Book 2: Microbiology — First Principles ──────────────────────────────────
insert into public.books (id, title, author, subject, description, cover_color, is_default, license, license_url)
values (
  'b0000002-0000-4000-8000-000000000000',
  'Microbiology: First Principles',
  'Athena Demo Library',
  'Microbiology',
  'Bacterial structure and infection-control basics condensed into two high-yield chapters. Perfect for testing the AI quiz generator.',
  '#8B5CF6',
  true,
  'Athena original content — free to use in this app',
  null
)
on conflict (id) do nothing;

insert into public.chapters (id, book_id, number, title, content)
values
(
  'c0000002-0000-4000-8000-000000000001',
  'b0000002-0000-4000-8000-000000000000',
  1,
  'Bacterial Cell Structure',
  $ch$
Bacteria are prokaryotes: their genetic material is not enclosed in a membrane-bound nucleus, they lack mitochondria and other membrane-bound organelles, and their ribosomes are 70S rather than 80S. Most bacteria carry a single circular chromosome in a region called the nucleoid, and many also carry plasmids — small extrachromosomal DNA circles that can carry genes for antibiotic resistance and can be transferred between cells.

Bacteria come in three classic shapes: spherical cocci, rod-shaped bacilli, and spiral forms (rigid spirilla and flexible spirochetes). Cocci often remain attached after division, forming pairs (diplococci, such as Neisseria), chains (streptococci) or grape-like clusters (staphylococci).

The cell envelope is the key to classification and to antibiotic action. The cytoplasmic membrane is a phospholipid bilayer that lacks sterols — except in Mycoplasma, which incorporates sterols into its membrane and has no cell wall at all. Outside the membrane sits peptidoglycan, a mesh of alternating N-acetylglucosamine and N-acetylmuramic acid sugars cross-linked by short peptides. The cross-linking enzyme is the target of beta-lactam antibiotics such as penicillin, which is why these drugs weaken the wall and cause cells to lyse.

Gram-positive bacteria have a thick, multi-layered peptidoglycan wall laced with teichoic acids. Gram-negative bacteria have only a thin peptidoglycan layer, but outside it they have a second, outer membrane containing lipopolysaccharide (LPS). The lipid A portion of LPS is endotoxin, which can trigger fever and septic shock; the O-antigen portion varies between strains. Between the inner and outer membranes lies the periplasmic space, which holds enzymes such as beta-lactamases that can destroy penicillins before they reach their targets.

Many bacteria wear additional structures. A polysaccharide capsule resists phagocytosis and is a major virulence factor — it is also the basis of some vaccines, such as the pneumococcal vaccine. Flagella, made of flagellin (the H antigen), provide motility and chemotaxis; they can be arranged as a single polar flagellum, a tuft at one pole, or many around the cell. Pili or fimbriae mediate adhesion to host surfaces, a prerequisite for colonization; a special sex pilus forms the bridge for conjugation, the transfer of plasmid DNA between bacteria.

Inside the cell, the 70S ribosome — composed of 30S and 50S subunits — is the target of many antibiotics: aminoglycosides bind the 30S subunit, while macrolides bind the 50S subunit. Inclusion bodies store nutrients or waste. Certain gram-positive genera, notably Bacillus and Clostridium, form endospores: dormant, dehydrated, highly resistant structures that survive heat, disinfectants and time, and germinate when conditions improve.

Mycobacteria such as Mycobacterium tuberculosis have a waxy wall rich in mycolic acid. This makes them impermeable to many stains, so they are detected with acid-fast staining such as Ziehl–Neelsen, and it also makes them intrinsically resistant to many antibiotics and disinfectants.

Key points:
- Prokaryotic cell: no nuclear membrane, 70S ribosomes, single circular chromosome, often plasmids.
- Peptidoglycan is thick in gram-positives and thin in gram-negatives; gram-negatives add an outer membrane with LPS (endotoxin = lipid A).
- Beta-lactams block peptidoglycan cross-linking; aminoglycosides target 30S and macrolides 50S ribosomal subunits.
- Capsule resists phagocytosis; pili adhere and enable conjugation; flagella (H antigen) provide motility.
- Mycoplasma has no cell wall; mycobacteria have mycolic acid and are acid-fast.
- Bacillus and Clostridium form heat-resistant endospores.
  $ch$
),
(
  'c0000002-0000-4000-8000-000000000002',
  'b0000002-0000-4000-8000-000000000000',
  2,
  'Sterilization and Disinfection',
  $ch$
Sterilization means destroying or removing all forms of microbial life, including bacterial spores, from an object. Disinfection means reducing the number of pathogenic organisms on inanimate objects; it may leave some organisms, particularly spores, alive. Antisepsis is the same idea applied to living tissue, and sanitization is a looser term for lowering the microbial load to a safe level.

The Spaulding classification links the method to the risk of infection. Critical items — those that enter sterile tissue or the bloodstream, such as surgical instruments — must be sterilized. Semicritical items — those contacting mucous membranes, such as endoscopes — require at least high-level disinfection. Noncritical items — those touching intact skin, such as blood-pressure cuffs — need low-level disinfection at most.

Heat is the most reliable sterilizing agent. Moist heat in an autoclave kills everything, including spores, at 121°C under 15 psi for 15–20 minutes, or at 134°C for about 3 minutes. Sterilization is verified with biological indicators containing Geobacillus stearothermophilus spores and with chemical indicator tape. Boiling at 100°C for 10 minutes kills most vegetative bacteria but not spores, so it is disinfection, not sterilization. Pasteurization uses gentler heat — 63°C for 30 minutes, or 72°C for about 15 seconds — to reduce pathogens in milk without cooking it. Dry heat requires higher temperatures and longer times; a hot-air oven runs at about 160°C for two hours, and incineration destroys items completely.

Filtration physically removes organisms from heat-sensitive solutions through membranes with pores of 0.22 µm, which hold back bacteria but not viruses. In rooms, HEPA filters remove airborne particles and microorganisms. Radiation provides cold sterilization: ionizing radiation such as gamma rays penetrates deeply and is used on prepacked disposable equipment, while ultraviolet light at about 254 nm damages DNA by forming thymine dimers but penetrates poorly, so it only disinfects surfaces, air and water.

Chemical agents fill the remaining gaps. Alcohols (60–90% isopropyl or ethanol) are excellent for rapid skin and surface disinfection but evaporate quickly and do not kill spores. Chlorine-releasing compounds such as hypochlorite disinfect spills and water; a 0.5–1% solution handles blood spills. Glutaraldehyde 2% is a high-level disinfectant for heat-sensitive equipment such as endoscopes, requiring hours of soaking. Hydrogen peroxide and peracetic acid provide fast, sporicidal, environmentally friendly options. Ethylene oxide gas sterilizes heat-sensitive medical devices in a sealed chamber. Quaternary ammonium compounds are low-level disinfectants used on floors and furniture.

Resistance to killing follows a predictable order, from hardest to easiest: prions, then bacterial spores, then mycobacteria, then cysts and protozoa, then fungi, then viruses, then ordinary vegetative bacteria. This hierarchy explains why antibiotics and antiseptics are different tools, and why instrument reprocessing follows strict steps: thorough cleaning first (organic debris protects microbes), then disinfection, then sterilization, then dry, protected storage.

Key points:
- Sterilization kills all life including spores; disinfection kills most pathogens but may leave spores; antisepsis is disinfection of living tissue.
- Spaulding: critical items → sterilize; semicritical → high-level disinfection; noncritical → low-level disinfection.
- Autoclave: 121°C, 15 psi, 15–20 min; spores are the biological monitor.
- Filtration (0.22 µm) for heat-sensitive liquids; gamma radiation for prepacked disposables; UV for surfaces and air only.
- Alcohols are not sporicidal; glutaraldehyde and hydrogen peroxide are high-level; ethylene oxide sterilizes heat-sensitive devices.
- Killing resistance order: prions > spores > mycobacteria > cysts > vegetative bacteria.
  $ch$
)
on conflict (id) do nothing;
