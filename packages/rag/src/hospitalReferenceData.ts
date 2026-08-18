/**
 * Hospital-reference corpus: clinical-prep and hospital-policy questions (fasting rules,
 * what to bring for admission, visiting hours, discharge process, insurance/billing
 * basics), retrievable via the `search_hospital_reference` tool -- see
 * apps/orchestrator/src/tools.ts. Separate corpus/collection from faqData.ts's FAQ_DOCS,
 * which only answers questions about Vita itself (see docs/BUILD_GUIDE.md §3.7).
 *
 * SAMPLE-CONTENT NOTE: no real, hospital-verified policy or clinical-prep content exists
 * anywhere in the EasyHMS ecosystem today (no admin UI, no document store). These ~14
 * docs are hand-written, illustrative placeholders standing in for that real content --
 * deliberately hedged/general-guidance phrasing rather than absolute clinical directives,
 * as one layer of a two-layer safety mitigation. The other layer is
 * pipeline.ts's SYSTEM_PROMPT, which instructs the model to always follow anything from
 * this tool with a spoken reminder to confirm exact details with hospital staff. Swap
 * this array's contents for real hospital-specific content later; nothing else about the
 * ingest/retrieval pipeline needs to change.
 *
 * `id` must be a valid Qdrant point id (unsigned int or UUID string) -- same constraint
 * as faqData.ts's FaqDoc, same reason: a fixed literal UUID generated once
 * (crypto.randomUUID()), not derived from `slug`.
 */
export interface ReferenceDoc {
  id: string;
  slug: string;
  title: string;
  category: 'clinical_prep' | 'hospital_policy';
  body: string;
}

export const HOSPITAL_REFERENCE_DOCS: ReferenceDoc[] = [
  {
    id: 'b9098098-216e-4a5d-bd39-c49060161704',
    slug: 'fasting-blood-glucose-lipid',
    title: 'Fasting before a blood glucose or lipid test',
    category: 'clinical_prep',
    body:
      'Patients are generally asked to fast (no food or drink other than plain water) for around 8 to 12 hours before a fasting blood glucose or lipid profile test, typically done as an early-morning appointment. Usual medications can usually still be taken with water unless a doctor has said otherwise. Exact timing can vary by test and by doctor, so patients should confirm with hospital staff or their doctor when the test is booked.',
  },
  {
    id: '8732da1b-20a8-4ddd-9e4f-9ae8e5ab5c77',
    slug: 'ultrasound-abdomen-prep',
    title: 'Preparing for an abdominal ultrasound',
    category: 'clinical_prep',
    body:
      'An abdominal ultrasound generally works best with a full bladder and an empty stomach, so patients are usually asked to fast for around 6 hours beforehand and drink water shortly before the scan without emptying their bladder. Requirements can differ depending on which part of the abdomen is being scanned, so patients should confirm the specific instructions with hospital staff at the time of booking.',
  },
  {
    id: '8594622f-119d-44e7-9eca-dc33bc1252e1',
    slug: 'pre-operative-npo',
    title: 'Pre-operative fasting (NPO) instructions',
    category: 'clinical_prep',
    body:
      'Before most surgeries requiring anesthesia, patients are generally asked to stop eating solid food around 6 to 8 hours before the procedure and stop clear liquids around 2 hours before, to reduce the risk of complications during anesthesia. Exact timing depends on the type of surgery, the anesthesia plan, and the patient, so patients should always follow the specific instructions given by their surgeon or anesthesiologist rather than a general rule.',
  },
  {
    id: 'e716727a-c2e7-4a12-bed2-5106a75f0187',
    slug: 'mri-prep',
    title: 'Preparing for an MRI scan',
    category: 'clinical_prep',
    body:
      'For most MRI scans, patients are asked to remove metal objects (jewelry, watches, hairpins) and inform staff of any implants, pacemakers, or metal fragments in the body, since these can be unsafe or affect image quality. Some MRI scans (such as of the abdomen) may also require a period of fasting beforehand. Patients with a fear of enclosed spaces should mention this in advance, since sedation options may be available. Patients should confirm scan-specific prep with hospital staff when booking.',
  },
  {
    id: '539a67db-e6bd-4a80-8cc0-a8bdd6def8c4',
    slug: 'colonoscopy-prep',
    title: 'Preparing for a colonoscopy',
    category: 'clinical_prep',
    body:
      'A colonoscopy generally requires a clear-liquid diet for about a day beforehand and a prescribed bowel-cleansing preparation taken the evening before or morning of the procedure, so the bowel is empty enough for a clear view. Certain regular medications, especially blood thinners, may need to be paused beforehand under a doctor\'s guidance. Because the exact prep regimen and timing vary by doctor and by the prescribed solution, patients should follow the specific instructions given at booking rather than a general timeline.',
  },
  {
    id: '79e5c2fc-f2f3-45d0-8473-2989470f2cd6',
    slug: 'visiting-hours',
    title: 'Hospital visiting hours',
    category: 'hospital_policy',
    body:
      'General ward visiting hours are typically in the late afternoon and early evening, with a limited number of visitors allowed per patient at a time to avoid overcrowding. ICU and post-operative areas usually have shorter, more restricted visiting windows for infection-control reasons, and may only allow one immediate family member at a time. Exact hours can vary by ward and by hospital, so visitors should confirm at the reception or nursing station on arrival.',
  },
  {
    id: 'e0046c78-93f1-4d8f-9a15-a6cb50bf6b30',
    slug: 'opd-registration-documents',
    title: 'Documents needed for OPD (outpatient) registration',
    category: 'hospital_policy',
    body:
      'For a routine outpatient (OPD) visit, patients are generally asked to bring a valid government photo ID (such as an Aadhaar card), any previous prescriptions or medical records relevant to the visit, and insurance or health-scheme cards if applicable. First-time patients may also be asked for basic contact and address details for registration. Specific requirements can vary by department, so patients should check with reception if unsure.',
  },
  {
    id: '8d8bb5f7-5a58-4021-b9ef-76b3597cb908',
    slug: 'ipd-admission-documents',
    title: 'Documents needed for IPD (inpatient) admission',
    category: 'hospital_policy',
    body:
      'For a planned inpatient admission, patients are generally asked to bring a valid government photo ID, the doctor\'s admission advice or referral letter, relevant prior medical records and test reports, insurance or health-scheme documents if applicable, and details of a family member or attendant who can be contacted. An advance deposit is usually required at admission unless covered by a cashless insurance arrangement -- see the billing and advance-deposit policy for details.',
  },
  {
    id: '36da158a-5476-4a3f-be3c-87b571236116',
    slug: 'discharge-process',
    title: 'Discharge process and turnaround time',
    category: 'hospital_policy',
    body:
      'Discharge typically begins once the treating doctor signs off during rounds, after which the discharge summary, final bill, and any pending reports are prepared. This process commonly takes a few hours from the doctor\'s sign-off to the patient actually leaving, depending on billing and pharmacy clearance, so families should plan for some waiting time. Patients should ask the ward nursing staff for an estimated discharge time on the day itself, since it can vary by case.',
  },
  {
    id: '00f90f6b-7d96-408b-9404-b7d9ce72e3da',
    slug: 'insurance-cashless-claim-basics',
    title: 'Insurance and cashless claim basics',
    category: 'hospital_policy',
    body:
      'For a cashless insurance claim, patients generally need to share their insurance/TPA card and policy details with the hospital\'s insurance desk as early as possible, ideally before or at admission for planned procedures. The hospital\'s insurance desk sends a pre-authorization request to the insurer/TPA, and treatment can begin once approval is received (or, for emergencies, often begins first with approval sought in parallel). Approval amounts and coverage depend entirely on the individual policy, so patients should confirm coverage details directly with their insurer or the hospital\'s insurance desk.',
  },
  {
    id: '28475032-a1de-48a9-8bac-dbcb623a1d7a',
    slug: 'billing-advance-deposit-policy',
    title: 'Billing and advance-deposit policy',
    category: 'hospital_policy',
    body:
      'Inpatient admissions generally require an advance deposit at the time of admission, with the amount typically depending on the expected procedure or length of stay; this is adjusted against the final bill at discharge, with any balance refunded or an additional amount due as applicable. Common payment modes include cash, card, and UPI; itemized bills are usually available on request. Patients with cashless insurance coverage should confirm with the insurance desk whether a deposit is still required for their specific policy.',
  },
  {
    id: '52a1fbab-b27d-45c1-81c2-a7b2b6dd840b',
    slug: 'patient-grievance-redressal',
    title: 'Patient grievance redressal process',
    category: 'hospital_policy',
    body:
      'Patients or family members with a concern or complaint can generally raise it first with the ward nursing staff or the front-desk/reception team for quick resolution. For concerns that need more formal follow-up, most hospitals have a patient relations or grievance desk that can be contacted directly, and complaints are typically logged and followed up within a defined turnaround time. Patients should ask reception for the current grievance-desk contact details, since these can change.',
  },
  {
    id: '58f13e39-0358-4431-9165-ead7a8fbb012',
    slug: 'ecg-stress-test-prep',
    title: 'Preparing for an ECG or cardiac stress test',
    category: 'clinical_prep',
    body:
      'A resting ECG usually needs no special preparation, but patients are generally asked to avoid heavy meals, caffeine, and smoking for a few hours before a cardiac stress test (treadmill test), and to wear comfortable clothing and footwear suitable for walking. Certain heart or blood-pressure medications may need to be paused beforehand under a doctor\'s guidance. Patients should confirm test-specific instructions with hospital staff when the test is booked.',
  },
  {
    id: 'e91261df-36d6-4db5-a497-305c3f451719',
    slug: 'opd-appointment-arrival-time',
    title: 'When to arrive for an OPD appointment',
    category: 'hospital_policy',
    body:
      'Patients are generally advised to arrive around 15 to 30 minutes before their scheduled OPD appointment time to allow for registration and any waiting-room formalities. Since appointment times booked through Vita are non-binding preferred times rather than fixed slots, actual consultation timing can vary depending on the doctor\'s ongoing schedule, so some additional waiting time should be expected.',
  },
];

/** Text embedded/indexed per doc -- same role as faqData.ts's faqEmbedText: used
 * identically by indexCorpus()'s BM25 half (in-process, at orchestrator boot) and
 * ingest.ts's dense/Qdrant half, so both halves of hybrid search are built from the same
 * source text. */
export function referenceEmbedText(doc: ReferenceDoc): string {
  return `${doc.title}\n${doc.body}`;
}
