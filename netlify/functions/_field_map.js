const LEGACY_TO_DB = {
  'project-status': 'project_status',
  'agreed-delivery-date': 'agreed_delivery_date',
  'client-name': 'client_name',
  'brand-name': 'brand_name',
  'client-website': 'client_website',
  'client-country': 'client_country',
  'brand-logo-ref': 'brand_logo_ref',

  'q1-business-description': 'business-description',
  'q2-problem-transformation': 'problem-transformation',
  'q3-ideal-customer': 'ideal-customer',
  'q3b-customer-desire': 'customer-desire',
  'q4-competitors': 'competitors',
  'q5-brand-personality': 'brand-personality',
  'q6-positioning': 'positioning',
  'q-launch-context': 'launch-context',
  'q8-brands-admired': 'brands-admired',
  'q9-color': 'color_direction',
  'q9-color-feelings': 'color_choice',
  'q10-colors-to-avoid': 'colors-to-avoid',
  'q11-aesthetic': 'aesthetic',
  'q11-aesthetic-description': 'aesthetic-description',
  'q13-deliverables': 'deliverables',
  'q14-budget': 'budget',
  'q15-inspiration-refs': 'inspiration-refs',
  'q7-decision-maker': 'decision-maker',
  'q7-decision-maker-other': 'decision-maker-other',
  'q12-existing-assets': 'existing-assets',
  'q16-anything-else': 'anything-else'
};

const DB_TO_LEGACY = Object.fromEntries(Object.entries(LEGACY_TO_DB).map(([legacy, db]) => [db, legacy]));

function toDbKey(key) {
  return LEGACY_TO_DB[key] || key;
}

function toLegacyKey(key) {
  return DB_TO_LEGACY[key] || key;
}

function toDbRecord(record = {}) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[toDbKey(key)] = value;
  }
  return out;
}

function toLegacyRecord(record = {}) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[toLegacyKey(key)] = value;
  }
  return out;
}

const FORM_FIELDS_LEGACY = [
  'client-name', 'brand-name', 'email', 'client-website', 'delivery-date',
  'q1-business-description', 'q2-problem-transformation', 'q3-ideal-customer',
  'q3b-customer-desire', 'q4-competitors', 'q5-brand-personality', 'q6-positioning',
  'q-launch-context', 'q7-decision-maker', 'q7-decision-maker-other', 'q8-brands-admired',
  'q9-color', 'q9-color-feelings', 'q10-colors-to-avoid', 'q11-aesthetic', 'q11-aesthetic-description',
  'q12-existing-assets', 'q13-deliverables', 'q14-budget',
  'q15-inspiration-refs', 'q16-anything-else'
];

const FORM_FIELDS_DB = FORM_FIELDS_LEGACY.map(toDbKey);

module.exports = {
  toDbKey,
  toLegacyKey,
  toDbRecord,
  toLegacyRecord,
  FORM_FIELDS_LEGACY,
  FORM_FIELDS_DB
};
