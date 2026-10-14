// Phase 40 Part C: the app's topic tags. A tutoring class's topics map to these (a table, then one
// checked model call for a topic the table doesn't know), every word of the class carries them, and
// scenarios with a matching topic may use the class's words as allowed extras (shown in the
// scenario's word list and its Garden plot). Pure data and lookups.

export const TOPIC_TAGS = [
  'food',
  'health',
  'places',
  'transport',
  'shopping',
  'family',
  'work',
  'school',
  'travel',
  'home',
  'hobbies',
  'weather',
  'time',
  'money',
  'language',
  'people',
] as const;
export type TopicTag = (typeof TOPIC_TAGS)[number];

export const isTopicTag = (s: string): s is TopicTag => (TOPIC_TAGS as readonly string[]).includes(s);

/** The tag a word carries for a topic ("topic:food"). */
export const topicWordTag = (t: TopicTag): string => `topic:${t}`;

/** The topics of each built-in scenario (by id). Textbook lesson scenarios are listed by their id. */
export const SCENARIO_TOPICS: Readonly<Record<string, readonly TopicTag[]>> = {
  'clinic-call': ['health', 'places'],
  'convenience-store': ['shopping', 'food', 'money'],
  'easycard-topup': ['transport', 'money', 'places'],
  'landlord-deposit': ['home', 'money'],
  'night-market': ['food', 'shopping', 'places'],
  'tea-shop': ['food', 'shopping'],
  youbike: ['transport', 'places'],
  'laixue-1-L01-language-exchange': ['language', 'people'],
  'laixue-1-L02-siblings-chat': ['family', 'people'],
  'laixue-1-L03-family-jobs': ['family', 'work'],
  'laixue-1-L04-parents-jobs': ['family', 'work'],
  'laixue-1-L05-introduce-friend': ['people', 'home'],
  'laixue-1-L06-weekend-hobbies': ['hobbies', 'time'],
  'laixue-1-L07-bank-call': ['work', 'places', 'money'],
  'laixue-1-L08-plan-birthday': ['family', 'time', 'food'],
  'laixue-1-L09-dinner-invite': ['food', 'work', 'places'],
  'laixue-1-L10-coffee-break': ['language', 'food', 'school'],
  'laixue-2-L01-park-weather': ['weather', 'hobbies'],
  'laixue-2-L02-gift-shopping': ['shopping', 'family'],
  'laixue-2-L03-restaurant-order': ['food', 'places'],
  'laixue-2-L04-coffee-shop': ['food', 'shopping'],
  'laixue-2-L05-clothes-shop': ['shopping', 'money'],
  'laixue-2-L06-moving-house': ['home', 'places'],
  'laixue-2-L07-find-supermarket': ['places', 'shopping'],
  'laixue-2-L08-daily-routine': ['time', 'work', 'food'],
  'laixue-2-L09-doctor-visit': ['health', 'places'],
  'laixue-2-L10-plan-taiwan-trip': ['travel', 'time'],
  'laixue-3-L01-first-day-class': ['school', 'people'],
  'laixue-3-L02-beach-vacation': ['travel', 'hobbies', 'weather'],
  'laixue-3-L03-thanksgiving-plans': ['food', 'family', 'time'],
  'laixue-3-L04-new-branch-office': ['work', 'places'],
  'laixue-3-L05-tea-shop': ['food', 'shopping'],
  'laixue-3-L06-new-colleagues': ['work', 'people'],
  'laixue-3-L07-europe-business-trip': ['travel', 'work'],
  'laixue-3-L08-mistake-at-work': ['work', 'money'],
  'laixue-3-L09-weekend-plans': ['home', 'hobbies', 'time'],
  'laixue-3-L10-progress-chat': ['school', 'language'],
  'laixue-4-L01-job-change-news': ['work', 'travel'],
  'laixue-4-L02-airport-pickup': ['travel', 'transport'],
  'laixue-4-L03-renting-apartment': ['home', 'money', 'places'],
  'laixue-4-L04-commute-choices': ['transport', 'work'],
  'laixue-4-L05-night-market-tour': ['food', 'places', 'shopping'],
  'laixue-4-L06-taipei-features': ['places', 'travel'],
  'laixue-4-L07-leisure-talk': ['hobbies'],
  'laixue-4-L08-wedding-invitation': ['people', 'family', 'time'],
  'laixue-4-L09-island-trip': ['travel', 'transport'],
  'laixue-4-L10-taiwan-experience': ['travel', 'food', 'people'],
};

/** A scenario's topics (none for one the table doesn't list). */
export const scenarioTopics = (scenarioId: string): readonly TopicTag[] => SCENARIO_TOPICS[scenarioId] ?? [];

/**
 * A class topic (as printed, in Taiwan characters, and its English) → topic tags. The tutor's notes
 * name topics freely ("食物與一日三餐", "Health and seeing a doctor"), so this matches key words;
 * a topic with no match goes to the one model call at Save.
 */
export const TUTOR_TOPIC_RULES: ReadonlyArray<{ match: RegExp; tags: readonly TopicTag[] }> = [
  { match: /食|飲|餐|吃|菜|料理|點心|宵夜|food|meal|eat|drink|cook|dish|snack|breakfast|lunch|dinner|restaurant/i, tags: ['food'] },
  { match: /健康|就醫|醫|病|藥|身體|health|doctor|medic|hospital|clinic|pharmacy|sick|ill/i, tags: ['health'] },
  { match: /地點|地方|場所|服務|郵局|銀行|警察|place|location|service|post office|bank|police|where/i, tags: ['places'] },
  { match: /交通|捷運|公車|火車|開車|騎|transport|traffic|mrt|bus|train|drive|commute|bike|scooter/i, tags: ['transport'] },
  { match: /購物|買|商店|市場|shop|buy|store|market|clothes/i, tags: ['shopping'] },
  { match: /家人|家庭|父母|兄弟|姊妹|family|parent|sibling|relative/i, tags: ['family'] },
  { match: /工作|職業|公司|上班|work|job|career|office|company|colleague/i, tags: ['work'] },
  { match: /學校|上課|學習|考試|老師|school|class|study|exam|teacher|student/i, tags: ['school'] },
  { match: /旅行|旅遊|出國|度假|travel|trip|holiday|vacation|tour/i, tags: ['travel'] },
  { match: /住|房子|家裡|租|搬家|home|house|apartment|rent|move/i, tags: ['home'] },
  { match: /興趣|嗜好|愛好|運動|休閒|電影|音樂|hobby|hobbies|sport|leisure|movie|music|game/i, tags: ['hobbies'] },
  { match: /天氣|季節|weather|season|rain|hot|cold/i, tags: ['weather'] },
  { match: /時間|日期|星期|時候|每天|一日|time|date|day|week|schedule|routine/i, tags: ['time'] },
  { match: /錢|價|付|money|price|pay|cost|cheap|expensive/i, tags: ['money'] },
  { match: /語言|中文|國語|華語|language|mandarin|chinese/i, tags: ['language'] },
  { match: /朋友|人物|認識|介紹|friend|people|introduc|person|meet/i, tags: ['people'] },
];

/** The topic tags a class topic maps to by the table (empty = ask the model at Save). */
export function topicTagsFor(topic: { zh: string; en: string }): TopicTag[] {
  const text = `${topic.zh} ${topic.en}`;
  const out: TopicTag[] = [];
  for (const r of TUTOR_TOPIC_RULES) if (r.match.test(text)) for (const t of r.tags) if (!out.includes(t)) out.push(t);
  return out;
}
