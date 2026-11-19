/**
 * Word lists for the local rule-based command parser (English, Bangla script, Banglish).
 * Matching is case-insensitive and Unicode-aware. Bangla terms may carry suffixes
 * (খরচটা, খরচের), Latin terms may not. This is a fixed vocabulary, not a language model.
 */
export const LETTER = '\\p{L}\\p{M}\\p{N}';
const BANGLA = /[ঀ-৿]/;
export const escapeRe = (s: string) => s.normalize('NFC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex source matching any of `words` as a whole word. Bangla words only also match with
 * trailing suffixes (খরচটা, খরচের) when `prefix` is true; filler/date/currency words are strict
 * so that e.g. the filler "কর" can never match inside "করার".
 */
export function alt(words: string[], prefix = false): string {
  const parts = [...words].sort((a, b) => b.length - a.length).map((w) => {
    const body = escapeRe(w).replace(/ /g, '\\s+');
    return BANGLA.test(w) && prefix ? `${body}[${LETTER}]*` : `${body}(?![${LETTER}])`;
  });
  return `(?<![${LETTER}])(?:${parts.join('|')})`;
}
export const rx = (words: string[], prefix = false, flags = 'iu') => new RegExp(alt(words, prefix), flags);
export const rxAll = (words: string[], prefix = false) => rx(words, prefix, 'giu');

export const REMINDER_WORDS = [
  'remind me', 'reminder', 'remind', 'রিমাইন্ডার', 'মনে করিয়ে দাও', 'মনে করিয়ে দিও', 'মনে করিয়ে দিন', 'মনে করিয়ে',
  'mone koriye dao', 'mone koriye dio', 'mone koriye din', 'mone koriye', 'mone korie dao', 'mone korie',
];
export const EXPENSE_WORDS = [
  'expenses', 'expense', 'expenditure', 'spending', 'spent', 'spend', 'bought', 'paid',
  'খরচ', 'ব্যয়', 'khoroch', 'khorcho', 'khorch', 'kharach', 'khoros',
];
export const TASK_WORDS = ['to-do', 'todo', 'task', 'টাস্ক', 'কাজ', 'kaaj', 'kaj'];

/** Command filler removed from the description (never from the middle of a sentence's content words). */
export const FILLER_WORDS = [
  'please', 'pls', 'plz', 'kindly', 'add', 'create', 'new', 'record', 'log', 'save',
  'যোগ', 'যুক্ত', 'করো', 'করুন', 'কর', 'দাও', 'দিও', 'দিন', 'লিখে রাখো',
  'jog', 'joggo', 'koro', 'korun', 'kor', 'dao', 'dio', 'din', 'likhe rakho',
  'করেছি', 'করলাম', 'korechi', 'korlam',
];

/** Stripped only from the start/end of the remaining description. */
export const EDGE_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'on', 'of', 'me', 'i', 'my', 'by', 'till', 'until', 'ami', 'আমি', 'about', 'that', 'at', 'in', 'and', 'with', 'is', 'was',
  'jonno', 'jonyo', 'er', 'e', 'te', 'ke', 'ekta', 'ekti', 'ek', 'kotha', 'hoise', 'hoyeche', 'hoyese', 'holo', 'hoy',
  'জন্য', 'একটি', 'একটা', 'এক', 'কথা', 'হয়েছে', 'হইছে', 'হলো', 'হয়',
].map((w) => w.normalize('NFC')));

export const CURRENCY_WORDS: Record<string, string[]> = {
  BDT: ['taka', 'tk', 'bdt', 'টাকা', 'টাকার', 'টাকায়'],
  USD: ['usd', 'dollars', 'dollar', 'ডলার'],
  EUR: ['eur', 'euros', 'euro', 'ইউরো'],
  GBP: ['gbp', 'pounds', 'pound', 'পাউন্ড'],
  JPY: ['jpy', 'yen'],
};
export const CURRENCY_SYMBOLS: Record<string, string> = { '৳': 'BDT', $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };

export const DATE_WORDS = {
  today: ['today', 'tonight', 'aj', 'aaj', 'ajke', 'aajke', 'আজ', 'আজকে', 'আজকের'],
  yesterday: ['yesterday', 'gotokal', 'gotkal', 'gato kal', 'গতকাল', 'গত কাল'],
  tomorrow: ['tomorrow', 'tmrw', 'agamikal', 'agami kal', 'agamikaal', 'আগামীকাল', 'আগামী কাল', 'আগামিকাল'],
  dayAfterTomorrow: ['day after tomorrow'],
  /** "কাল" means BOTH yesterday and tomorrow in Bangla; "পরশু" is day-after-tomorrow or day-before-yesterday. */
  bareKal: ['kal', 'kaal', 'kalke', 'কাল', 'কালকে'],
  porshu: ['porshu', 'parshu', 'পরশু'],
};

/** Index = JS getDay() (0 = Sunday). */
export const WEEKDAYS: string[][] = [
  ['sunday', 'robibar', 'রবিবার'],
  ['monday', 'shombar', 'sombar', 'সোমবার'],
  ['tuesday', 'mongolbar', 'মঙ্গলবার'],
  ['wednesday', 'budhbar', 'বুধবার'],
  ['thursday', 'brihoshpotibar', 'brihospotibar', 'বৃহস্পতিবার'],
  ['friday', 'shukrobar', 'sukrobar', 'শুক্রবার'],
  ['saturday', 'shonibar', 'sonibar', 'শনিবার'],
];

export type Period = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
export const PERIOD_WORDS: Record<Period, string[]> = {
  morning: ['sokal', 'shokal', 'সকাল'],
  noon: ['dupur', 'dupure', 'দুপুর'],
  afternoon: ['bikal', 'bikel', 'বিকাল', 'বিকেল'],
  evening: ['shondha', 'sondha', 'সন্ধ্যা'],
  night: ['raat', 'rat', 'রাত'],
};

export const EXPENSE_CATEGORY_WORDS: Record<string, string[]> = {
  Food: ['food', 'lunch', 'dinner', 'breakfast', 'snack', 'snacks', 'grocery', 'groceries', 'meal', 'tea', 'coffee', 'restaurant', 'khabar', 'nasta', 'খাবার', 'খাবারের', 'খাওয়া', 'নাস্তা', 'নাস্তার'],
  Transport: ['transport', 'bus', 'rickshaw', 'cng', 'uber', 'pathao', 'taxi', 'train', 'fuel', 'petrol', 'jatayat', 'যাতায়াত', 'যাতায়াতে', 'বাস', 'রিকশা', 'রিকশায়'],
  Bills: ['bill', 'bills', 'electricity', 'gas', 'water', 'internet', 'wifi', 'rent', 'recharge', 'bidyut', 'biddut', 'বিল', 'বিদ্যুৎ', 'ইন্টারনেট'],
  Shopping: ['shopping', 'clothes', 'shirt', 'shoes', 'kenakata', 'কেনাকাটা', 'জামা'],
  Health: ['medicine', 'doctor', 'hospital', 'pharmacy', 'oshudh', 'ousudh', 'ওষুধ', 'ডাক্তার'],
  Education: ['tuition', 'school', 'book', 'books', 'course', 'বই', 'টিউশন'],
  Family: ['family', 'gift', 'পরিবার'],
};
/** "bazar" is groceries or general shopping, so it is deliberately listed in both so it stays ambiguous. */
EXPENSE_CATEGORY_WORDS.Food.push('bazar', 'বাজার');
EXPENSE_CATEGORY_WORDS.Shopping.push('bazar', 'বাজার');
