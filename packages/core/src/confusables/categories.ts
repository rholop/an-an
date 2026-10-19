// Phase 48 Part A: the meaning categories behind the `meaning` axis and the "all the same topic"
// odd-one-out check. A word is in a category when one of its English gloss phrases is a category
// keyword, or (for nouns) ends in a one-word keyword ("black tea" → drink). Hand-made and small on
// purpose: a category must be narrow enough that two of its words are a fair pair of options
// (平常 / 常常 frequency, 冰淇淋 / 巧克力 / 三明治 food, 廚師 / 醫師 occupation, 星期四 / 星期五 days).
// Pure data and lookups.

import { glossFor } from '../gloss/context.js';
import type { Word } from '../types.js';

export const MEANING_CATEGORIES = {
  food: [
    'ice cream', 'chocolate', 'sandwich', 'hamburger', 'burger', 'pizza', 'cake', 'bread', 'rice', 'noodles', 'noodle',
    'dumpling', 'dumplings', 'soup', 'egg', 'eggs', 'meat', 'beef', 'pork', 'chicken', 'fish', 'shrimp', 'tofu',
    'vegetable', 'vegetables', 'fruit', 'apple', 'banana', 'watermelon', 'mango', 'grape', 'grapes', 'pineapple',
    'strawberry', 'candy', 'sweets', 'cookie', 'cookies', 'biscuit', 'biscuits', 'steak', 'salad', 'dessert', 'snack',
    'snacks', 'sugar', 'bun', 'steamed bun', 'rice ball', 'fried rice', 'beef noodles', 'french fries', 'hot dog',
    'pudding', 'toast', 'sushi', 'hot pot', 'pastry', 'popcorn', 'food', 'pie', 'potatoes', 'potato', 'turkey',
    'buns', 'pineapple cake', 'mooncake', 'soup dumplings', 'stinky tofu', 'oyster omelet', 'scallion pancake',
    'tea', 'coffee', 'milk', 'juice', 'beer', 'wine', 'cola', 'soda', 'milk tea', 'bubble tea', 'pearl milk tea',
    'soy milk', 'black tea', 'green tea', 'iced tea', 'drink', 'beverage', 'latte',
  ],
  holiday: ['festival', 'thanksgiving', 'christmas', 'new year', 'chinese new year', 'lunar new year', 'mid-autumn festival', 'dragon boat festival', 'lantern festival', 'holiday', 'birthday', 'wedding', "valentine's day"],
  thing: [
    'souvenir', 'gift', 'present', 'cosmetics', 'luggage', 'suitcase', 'umbrella', 'wallet', 'bag', 'backpack', 'key', 'keys',
    'phone', 'cellphone', 'cell phone', 'mobile phone', 'computer', 'laptop', 'camera', 'watch', 'glasses', 'sunglasses',
    'credit card', 'passport', 'ticket', 'book', 'pen', 'pencil', 'notebook', 'map', 'newspaper', 'magazine', 'dictionary',
    'television', 'tv', 'refrigerator', 'fridge', 'air conditioner', 'table', 'desk', 'chair', 'bed', 'sofa', 'lamp', 'clock',
    'cup', 'bowl', 'plate', 'chopsticks', 'spoon', 'knife', 'bottle', 'box', 'photo', 'photograph', 'picture', 'letter', 'email',
  ],
  person: ['friend', 'boyfriend', 'girlfriend', 'classmate', 'neighbor', 'neighbour', 'colleague', 'coworker', 'guest', 'customer', 'tourist', 'visitor', 'stranger', 'roommate', 'man', 'woman', 'boy', 'girl', 'child', 'adult', 'foreigner', 'everyone', 'people', 'person'],
  housePart: ['window', 'door', 'wall', 'floor', 'stairs', 'elevator', 'roof', 'gate', 'garden', 'yard', 'dormitory', 'dorm', 'apartment', 'house', 'home'],
  street: ['intersection', 'crossroads', 'street', 'road', 'alley', 'lane', 'corner', 'entrance', 'exit', 'traffic light', 'sidewalk', 'bridge', 'street corner'],
  meal: ['breakfast', 'lunch', 'dinner', 'supper', 'meal', 'late-night snack'],
  weekday: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekend', 'weekday'],
  relativeDay: ['today', 'tomorrow', 'yesterday', 'day after tomorrow', 'day before yesterday', 'this year', 'next year', 'last year', 'this week', 'next week', 'last week', 'this month', 'next month', 'last month'],
  month: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  dayPart: ['morning', 'afternoon', 'evening', 'night', 'noon', 'midnight', 'early morning', 'tonight', 'this morning', 'at night', 'in the morning', 'in the evening'],
  season: ['spring', 'summer', 'autumn', 'winter'],
  occupation: [
    'teacher', 'doctor', 'cook', 'chef', 'nurse', 'engineer', 'lawyer', 'student', 'businessman', 'businessperson',
    'waiter', 'waitress', 'secretary', 'driver', 'police', 'policeman', 'police officer', 'soldier', 'farmer', 'worker',
    'clerk', 'salesperson', 'manager', 'boss', 'reporter', 'journalist', 'writer', 'singer', 'actor', 'actress',
    'artist', 'professor', 'scientist', 'accountant', 'employee', 'housewife', 'homemaker', 'designer', 'programmer',
    'pilot', 'tour guide', 'guide', 'dentist', 'pharmacist', 'architect', 'photographer', 'musician', 'painter',
    'shop assistant', 'salesclerk', 'civil servant', 'principal', 'athlete', 'flight attendant', 'barber',
  ],
  family: [
    'father', 'mother', 'dad', 'mom', 'mum', 'older brother', 'younger brother', 'elder brother', 'older sister',
    'younger sister', 'elder sister', 'brother', 'sister', 'son', 'daughter', 'grandfather', 'grandmother', 'grandpa',
    'grandma', 'uncle', 'aunt', 'husband', 'wife', 'cousin', 'parents', 'child', 'children', 'kid', 'kids', 'baby',
    'grandson', 'granddaughter', 'grandchild', 'siblings', 'brothers and sisters', 'family',
  ],
  frequency: ['often', 'usually', 'always', 'sometimes', 'never', 'seldom', 'rarely', 'frequently', 'normally', 'generally', 'occasionally', 'ordinarily', 'regularly', 'every day', 'all the time'],
  degree: ['very', 'extremely', 'quite', 'rather', 'too', 'really', 'especially', 'particularly', 'fairly', 'a little', 'a bit', 'somewhat', 'most', 'more', 'even more', 'highly', 'terribly', 'slightly', 'not very'],
  colour: ['red', 'blue', 'green', 'yellow', 'black', 'white', 'purple', 'pink', 'brown', 'gray', 'grey', 'orange', 'gold', 'silver', 'color', 'colour'],
  body: ['head', 'hand', 'hands', 'foot', 'feet', 'leg', 'legs', 'eye', 'eyes', 'ear', 'ears', 'mouth', 'nose', 'face', 'hair', 'tooth', 'teeth', 'stomach', 'belly', 'arm', 'finger', 'heart', 'body', 'neck', 'shoulder', 'throat'],
  transport: ['car', 'bus', 'train', 'subway', 'metro', 'mrt', 'taxi', 'bicycle', 'bike', 'motorcycle', 'scooter', 'motor scooter', 'motorbike', 'airplane', 'plane', 'aeroplane', 'boat', 'ship', 'high speed rail', 'high-speed rail', 'tram', 'vehicle'],
  place: [
    'school', 'hospital', 'bank', 'post office', 'restaurant', 'library', 'park', 'supermarket', 'store', 'shop',
    'convenience store', 'market', 'night market', 'station', 'train station', 'bus stop', 'airport', 'hotel',
    'museum', 'company', 'office', 'cinema', 'movie theater', 'department store', 'gym', 'church', 'temple', 'zoo',
    'university', 'college', 'clinic', 'pharmacy', 'bookstore', 'cafe', 'coffee shop', 'teahouse', 'mall',
    'shopping mall', 'beach', 'factory', 'police station', 'stadium', 'swimming pool', 'tea shop',
  ],
  room: ['kitchen', 'bedroom', 'living room', 'bathroom', 'dining room', 'toilet', 'restroom', 'balcony', 'room'],
  animal: ['dog', 'cat', 'bird', 'horse', 'cow', 'pig', 'sheep', 'tiger', 'monkey', 'rabbit', 'mouse', 'rat', 'elephant', 'bear', 'duck', 'animal', 'lion', 'snake', 'dragon', 'panda'],
  weather: ['rain', 'snow', 'wind', 'sunny', 'cloudy', 'typhoon', 'weather', 'thunder', 'rainy', 'windy', 'fog', 'cloud', 'clouds', 'sunshine'],
  clothes: ['clothes', 'clothing', 'shirt', 'pants', 'trousers', 'skirt', 'dress', 'shoes', 'shoe', 'hat', 'cap', 'coat', 'jacket', 'socks', 'sweater', 't-shirt', 'jeans', 'suit', 'tie', 'scarf', 'gloves', 'shorts', 'uniform'],
  country: ['america', 'united states', 'usa', 'japan', 'china', 'taiwan', 'korea', 'south korea', 'france', 'germany', 'england', 'britain', 'uk', 'canada', 'italy', 'spain', 'australia', 'vietnam', 'thailand', 'country', 'mexico', 'russia', 'india', 'europe', 'asia', 'africa'],
  language: ['chinese', 'english', 'japanese', 'french', 'german', 'spanish', 'korean', 'language', 'mandarin', 'taiwanese', 'italian', 'chinese language', 'english language'],
  sport: ['basketball', 'baseball', 'soccer', 'football', 'tennis', 'swimming', 'swim', 'badminton', 'volleyball', 'golf', 'ping pong', 'table tennis', 'jogging', 'yoga', 'sport', 'sports', 'exercise', 'mountain climbing', 'hiking', 'cycling'],
  feeling: ['happy', 'sad', 'angry', 'nervous', 'afraid', 'scared', 'tired', 'glad', 'worried', 'excited', 'bored', 'lonely', 'comfortable', 'uncomfortable', 'pleased', 'upset', 'annoyed', 'satisfied', 'disappointed', 'surprised', 'moved', 'touched', 'jealous'],
  taste: ['sweet', 'sour', 'bitter', 'spicy', 'hot and spicy', 'salty', 'delicious', 'tasty', 'bland', 'fragrant', 'greasy', 'oily'],
  direction: ['left', 'right', 'front', 'behind', 'above', 'below', 'inside', 'outside', 'east', 'west', 'south', 'north', 'next to', 'opposite', 'beside', 'in front', 'on top', 'underneath', 'middle', 'nearby'],
  number: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand', 'ten thousand', 'hundred million', 'zero', 'half'],
  temperature: ['hot', 'cold', 'cool', 'warm', 'humid', 'stuffy'],
  size: ['big', 'large', 'small', 'little', 'long', 'short', 'tall', 'high', 'low', 'fat', 'thin', 'wide', 'narrow', 'heavy'],
  // verbs and adjectives: everyday actions a learner mixes up (寫 / 讀 / 畫, 去 / 來 / 走)
  communicate: ['say', 'speak', 'talk', 'tell', 'ask', 'answer', 'reply', 'listen', 'hear', 'look', 'see', 'watch', 'read', 'write', 'draw', 'sing', 'call', 'explain', 'chat', 'introduce', 'teach', 'learn', 'study', 'practice', 'practise', 'review', 'look at', 'listen to', 'speak to'],
  move: ['go', 'come', 'walk', 'run', 'return', 'go back', 'come back', 'leave', 'enter', 'go out', 'come in', 'sit', 'stand', 'fly', 'climb', 'drive', 'ride', 'go up', 'go down', 'arrive', 'cross', 'turn', 'move', 'travel', 'jump'],
  daily: ['eat', 'drink', 'sleep', 'buy', 'sell', 'cook', 'wash', 'wear', 'put on', 'use', 'open', 'close', 'help', 'clean', 'take', 'bring', 'carry', 'give', 'send', 'pay', 'borrow', 'lend', 'rent', 'wait', 'rest', 'play', 'work', 'get up', 'shower', 'take a shower', 'brush', 'change', 'find', 'look for', 'put', 'throw away', 'cut', 'hold'],
  think: ['think', 'know', 'understand', 'decide', 'hope', 'want', 'like', 'love', 'hate', 'believe', 'remember', 'forget', 'plan', 'choose', 'guess', 'feel', 'worry', 'prefer', 'agree', 'wish', 'consider', 'intend'],
  quality: ['good', 'bad', 'beautiful', 'pretty', 'ugly', 'expensive', 'cheap', 'new', 'old', 'clean', 'dirty', 'fast', 'slow', 'busy', 'free', 'difficult', 'hard', 'easy', 'important', 'interesting', 'boring', 'convenient', 'inconvenient', 'quiet', 'noisy', 'lively', 'bustling', 'handsome', 'cute', 'smart', 'clever', 'right', 'wrong', 'correct', 'strange', 'special', 'famous', 'popular', 'safe', 'dangerous', 'healthy', 'polite', 'serious', 'careful', 'fresh', 'far', 'near', 'close', 'early', 'late', 'full', 'hungry', 'thirsty', 'sick', 'ill'],
  // closed word classes, matched by part of speech: they compete in the same slot (瓶 / 杯 / 碗)
  measure: [],
  particle: [],
  preposition: [],
  conjunction: [],
  modal: [],
} as const satisfies Record<string, readonly string[]>;

export type MeaningCategory = keyof typeof MEANING_CATEGORIES;

const exact = new Map<string, MeaningCategory[]>();
for (const [cat, keys] of Object.entries(MEANING_CATEGORIES) as Array<[MeaningCategory, readonly string[]]>)
  for (const k of keys) exact.set(k, [...(exact.get(k) ?? []), cat]);

const STOP = /^(to|a|an|the|be|one's|sb's|of|in|at|on|for)\s+/;

/** Which coarse parts of speech a category's words may have (so 喝 "to drink" is not food and 釣
 * "to fish" not an animal). */
const NOUN = ['N'];
const CATEGORY_POS: Record<MeaningCategory, readonly string[]> = {
  food: NOUN, meal: NOUN, weekday: NOUN, relativeDay: NOUN, month: NOUN, dayPart: NOUN, season: NOUN,
  occupation: NOUN, family: NOUN, body: NOUN, transport: NOUN, place: NOUN, room: NOUN, animal: NOUN,
  clothes: NOUN, country: NOUN, language: NOUN, direction: NOUN, number: NOUN,
  holiday: NOUN, thing: NOUN, person: NOUN, housePart: NOUN, street: NOUN,
  frequency: ['Adv', 'Vs', 'N'], degree: ['Adv'], // TOCFL tags some time words N (平常)
  colour: ['N', 'Vs'], feeling: ['Vs'], taste: ['Vs'], temperature: ['Vs'], size: ['Vs'], weather: ['N', 'Vs'],
  sport: ['N', 'V'],
  communicate: ['V'], move: ['V'], daily: ['V'], think: ['V'], quality: ['Vs'],
  measure: ['M'], particle: ['Ptc'], preposition: ['Prep'], conjunction: ['Conj'], modal: ['Vaux'],
};

/** Closed word classes: every word with the part of speech is in the category. */
const BY_POS: ReadonlyArray<[string, MeaningCategory]> = [
  ['M', 'measure'],
  ['Ptc', 'particle'],
  ['Prep', 'preposition'],
  ['Conj', 'conjunction'],
  ['conj', 'conjunction'],
  ['Vaux', 'modal'],
];

/** The gloss phrases a category is matched on: the learner-facing gloss and the primary gloss (the
 * dictionary's other senses are too noisy: 公車 "coach", 老師 "Taoist clergy leader"). */
function phrases(w: Pick<Word, 'glossEn' | 'senses' | 'primarySenseId' | 'textbookSenseId'>): string[] {
  const all = [glossFor(w), w.glossEn];
  const out = new Set<string>();
  for (const g of all)
    for (let part of g.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[;,/]/)) {
      part = part.replace(/[^a-z' -]+/g, ' ').replace(/\s+/g, ' ').trim();
      for (let k = 0; k < 2; k++) part = part.replace(STOP, '');
      if (part) out.add(part);
    }
  return [...out];
}

const isNoun = (w: Pick<Word, 'pos'>) => w.pos.some((p) => p === 'N' || p === 'Nb');
const catCache = new WeakMap<object, ReadonlySet<MeaningCategory>>();

/** The meaning categories of a word (empty for most words). */
export function meaningCategories(
  w: Pick<Word, 'pos' | 'glossEn' | 'senses' | 'primarySenseId' | 'textbookSenseId' | 'tags'>,
): ReadonlySet<MeaningCategory> {
  const hit = catCache.get(w);
  if (hit) return hit;
  const out = new Set<MeaningCategory>();
  const fams = posFamilies(w);
  const stative = w.pos.some((p) => p.startsWith('Vs'));
  // a word with no part of speech (some textbook words) fits any category its gloss names
  const fits = (c: MeaningCategory) => w.pos.length === 0 || CATEGORY_POS[c].some((p) => (p === 'Vs' ? stative : fams.has(p)));
  for (const [pos, c] of BY_POS) if (w.pos.includes(pos)) out.add(c);
  if (!w.tags.includes('name') && !w.tags.includes('proper-noun'))
    for (const p of phrases(w)) {
      for (const c of exact.get(p) ?? []) if (fits(c)) out.add(c);
      // "black tea", "high school teacher": a noun phrase ending in a one-word keyword
      if ((isNoun(w) || w.pos.length === 0) && p.includes(' ')) for (const c of exact.get(p.slice(p.lastIndexOf(' ') + 1)) ?? []) if (fits(c)) out.add(c);
    }
  catCache.set(w, out);
  return out;
}

/** Coarse part of speech: N, V (every verb type), Adv, and the rest as they are. */
export function posFamilies(w: Pick<Word, 'pos'>): Set<string> {
  return new Set(w.pos.map((p) => (p === 'Nb' ? 'N' : p.startsWith('V') ? 'V' : p.toLowerCase() === 'conj' ? 'Conj' : p)));
}

/** Same part of speech for the `meaning` axis. A stative verb and an adverb count as the same
 * (TOCFL tags 平常 Vs, 常常 Adv); a word with no part of speech matches any. */
export function samePosFamily(a: Pick<Word, 'pos'>, b: Pick<Word, 'pos'>): boolean {
  if (a.pos.length === 0 || b.pos.length === 0) return true; // unknown (some textbook words)
  const fa = posFamilies(a);
  const fb = posFamilies(b);
  if ([...fa].some((p) => fb.has(p))) return true;
  const stativeOrAdv = (w: Pick<Word, 'pos'>, f: Set<string>) => f.has('Adv') || w.pos.some((p) => p.startsWith('Vs'));
  return stativeOrAdv(a, fa) && stativeOrAdv(b, fb) && (fa.has('Adv') || fb.has('Adv'));
}
