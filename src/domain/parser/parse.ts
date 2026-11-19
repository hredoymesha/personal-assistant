import { addDays, isValidDateStr } from '../dates';
import { normalizeDigits } from '../money';
import {
  CURRENCY_SYMBOLS, CURRENCY_WORDS, DATE_WORDS, EDGE_STOPWORDS, EXPENSE_CATEGORY_WORDS, EXPENSE_WORDS, FILLER_WORDS,
  LETTER, PERIOD_WORDS, REMINDER_WORDS, TASK_WORDS, WEEKDAYS, alt, escapeRe, rx, rxAll, type Period,
} from './lexicon';

export type CommandKind = 'expense' | 'task' | 'reminder';
export type DraftField = 'kind' | 'title' | 'amount' | 'currency' | 'date' | 'time' | 'category';

/** Editable result of parsing. Nothing here is saved; see draft.ts for validation and conversion. */
export interface CommandDraft {
  original: string;
  kind: CommandKind | null;
  candidates: CommandKind[];
  title: string;
  amountText: string;
  currency: string | null;
  date: string | null;
  time: string | null;
  category: string | null;
  priority: 'low' | 'medium' | 'high';
  assumptions: string[];
  /** Why a field is unresolved (shown only while that field is still empty/invalid). */
  questions: Partial<Record<DraftField, string>>;
}

export type ParseResult = { ok: true; draft: CommandDraft } | { ok: false; error: string; original: string };

export const MAX_COMMAND_LENGTH = 500;
export const SUPPORTED_HELP = 'Try "I spent 120 taka on transport yesterday", "Remind me to pay the bill tomorrow" or "Add a task to buy groceries".';

const L = LETTER;
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';

function normalizeInput(s: string): string {
  return normalizeDigits(s.normalize('NFC'))
    .replace(/[।!?;"“”‘’()]/g, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface St { rest: string }
function take(st: St, re: RegExp): RegExpMatchArray | null {
  const m = st.rest.match(re);
  if (!m || m.index === undefined) return null;
  st.rest = st.rest.slice(0, m.index) + ' ' + st.rest.slice(m.index + m[0].length);
  return m;
}
function takeAll(st: St, re: RegExp): RegExpMatchArray[] {
  const ms = [...st.rest.matchAll(re)];
  if (ms.length) st.rest = st.rest.replace(re, ' ');
  return ms;
}

// ---------- time ----------
function periodHour(h: number, p: Period): number | null {
  switch (p) {
    case 'morning': return h >= 1 && h <= 11 ? h : null;
    case 'noon': return h === 12 ? 12 : h === 11 ? 11 : h >= 1 && h <= 3 ? h + 12 : null;
    case 'afternoon': return h >= 3 && h <= 6 ? h + 12 : null;
    case 'evening': return h >= 5 && h <= 8 ? h + 12 : null;
    case 'night': return h >= 7 && h <= 11 ? h + 12 : h === 12 ? 0 : h >= 1 && h <= 4 ? h : null;
  }
}
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const PERIOD_ALT = Object.values(PERIOD_WORDS).flat();
const periodOf = (w: string): Period =>
  (Object.entries(PERIOD_WORDS).find(([, ws]) => ws.some((x) => x.normalize('NFC').toLowerCase() === w.normalize('NFC').toLowerCase()))![0]) as Period;

function extractTime(st: St): { time: string | null; question?: string } {
  const found: (string | { q: string })[] = [];
  const at = `(?:(?<![${L}])at\\s+)?`;
  for (const m of takeAll(st, new RegExp(`${at}(?<![${L}\\d:.])(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm)(?![${L}])`, 'giu'))) {
    const h = Number(m[1]), mm = Number(m[2] ?? 0);
    if (h < 1 || h > 12) found.push({ q: `"${m[0].trim()}" is not a valid 12-hour time.` });
    else found.push(hhmm((h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0), mm));
  }
  for (const m of takeAll(st, new RegExp(`${at}(?<![\\d:.])([01]?\\d|2[0-3]):([0-5]\\d)(?![\\d:])`, 'giu'))) {
    found.push(hhmm(Number(m[1]), Number(m[2])));
  }
  const pre = alt(PERIOD_ALT);
  for (const m of takeAll(st, new RegExp(`(?:(${pre.slice(pre.indexOf('(?:'))})\\s*)?(?<![\\d:.,])(\\d{1,2})(?::([0-5]\\d))?\\s*(?:টায়|টার|টা|tay|tae|ta)(?![${L}])`, 'giu'))) {
    const h = Number(m[2]), mm = Number(m[3] ?? 0);
    if (!m[1]) { found.push({ q: `"${m[0].trim()}" needs a time of day, such as সকাল / বিকাল / রাত or am/pm, so I don't guess.` }); continue; }
    const hh = periodHour(h, periodOf(m[1]));
    found.push(hh === null ? { q: `"${m[0].trim()}" doesn't look like a valid time for that part of the day.` } : hhmm(hh, mm));
  }
  const bare = takeAll(st, new RegExp(`(?<![${L}])at\\s+(\\d{1,2})(?::[0-5]\\d)?(?![${L}\\d:])`, 'giu'));
  for (const m of bare) found.push({ q: `"${m[0].trim()}" is ambiguous. Add am or pm, or use 24-hour time like 17:00.` });
  if (!found.length) return { time: null };
  const q = found.find((f): f is { q: string } => typeof f !== 'string');
  if (q) return { time: null, question: q.q };
  const times = [...new Set(found as string[])];
  return times.length === 1 ? { time: times[0] } : { time: null, question: 'More than one time was mentioned. Pick one.' };
}

// ---------- dates ----------
interface DateOut { date: string | null; bareKal: boolean; question?: string; assumption?: string }

function extractDate(st: St, today: string): DateOut {
  const dates = new Set<string>();
  const notes: string[] = [];
  let bareKal = false, unclear: string | null = null;
  const add = (d: string) => dates.add(d);

  for (const m of takeAll(st, new RegExp(`(?<![\\d-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\d-])`, 'gu'))) {
    const s = `${m[1]}-${m[2]}-${m[3]}`;
    if (isValidDateStr(s)) add(s); else unclear = `"${s}" is not a real calendar date.`;
  }
  for (const m of takeAll(st, new RegExp(`(?:(?<![${L}])in\\s+(\\d{1,3})\\s+days?(?![${L}])|(?<![${L}\\d])(\\d{1,3})\\s*(?:দিন|din)\\s*(?:পরে|পর|pore|por)(?![${L}]))`, 'giu'))) {
    add(addDays(today, Number(m[1] ?? m[2])));
  }
  if (take(st, rx(DATE_WORDS.dayAfterTomorrow))) add(addDays(today, 2));
  if (take(st, rx(DATE_WORDS.yesterday))) add(addDays(today, -1));
  if (take(st, rx(DATE_WORDS.tomorrow))) add(addDays(today, 1));
  if (take(st, rx(DATE_WORDS.today))) add(today);

  const [y, mo, d] = today.split('-').map(Number);
  const todayWd = new Date(y, mo - 1, d).getDay();
  WEEKDAYS.forEach((names, wd) => {
    const re = new RegExp(`(?:(?<![${L}])(?:on|next|this|coming)\\s+)?${alt(names, true)}[${L}]*`, 'iu');
    if (take(st, re)) {
      const delta = (wd - todayWd + 7) % 7 || 7;
      const target = addDays(today, delta);
      add(target);
      notes.push(`"${names[0]}" was read as the next one after today - ${target}.`);
    }
  });
  if (take(st, rx(DATE_WORDS.porshu))) unclear = '"পরশু/porshu" can mean the day after tomorrow or the day before yesterday - pick the date.';
  if (take(st, rx(DATE_WORDS.bareKal))) bareKal = true;

  if (unclear) return { date: null, bareKal: false, question: unclear };
  if (dates.size + (bareKal ? 1 : 0) > 1) return { date: null, bareKal: false, question: 'More than one date was mentioned. Pick one.' };
  if (dates.size === 1) return { date: [...dates][0], bareKal: false, assumption: notes[0] };
  return { date: null, bareKal };
}

// ---------- amount ----------
const CUR_BY_WORD = new Map<string, string>();
for (const [code, ws] of Object.entries(CURRENCY_WORDS)) for (const w of ws) CUR_BY_WORD.set(w.normalize('NFC').toLowerCase(), code);
const CUR_BY_SYMBOL = new Map<string, string>(Object.entries(CURRENCY_SYMBOLS));
const WORDS_BODY = [...CUR_BY_WORD.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const SYMS = Object.keys(CURRENCY_SYMBOLS).map(escapeRe).join('');
const AMOUNT_RE = new RegExp(
  `(?<![${L}.,])(-\\s*)?${NUM}\\s*(?:(${WORDS_BODY})(?![${L}])|([${SYMS}]))` + // 250 taka | 250৳
  `|([${SYMS}])\\s*(-\\s*)?${NUM}(?![${L}.,])` + // ৳250
  `|(?<![${L}])(${WORDS_BODY})\\s+(-\\s*)?${NUM}(?![${L}.,])`, // tk 250
  'giu',
);
const PLAIN_RE = new RegExp(`(?<![${L}.,:-])(-\\s*)?${NUM}(?![${L}.,:]|\\d)`, 'giu');

interface AmountOut { amountText: string; currency: string | null; question?: string }

function extractAmount(st: St): AmountOut {
  const ms = takeAll(st, AMOUNT_RE);
  if (ms.length > 1) {
    return { amountText: '', currency: null, question: `More than one amount was found (${ms.map((m) => m[0].trim()).join(', ')}). Enter the one to save.` };
  }
  if (ms.length === 1) {
    const m = ms[0];
    const neg = m[1] ?? m[6] ?? m[9];
    const num = (m[2] ?? m[7] ?? m[10]).replace(/,/g, '');
    const cur = CUR_BY_WORD.get((m[3] ?? m[8] ?? '').normalize('NFC').toLowerCase()) ?? CUR_BY_SYMBOL.get(m[4] ?? m[5] ?? '') ?? null;
    return { amountText: (neg ? '-' : '') + num, currency: cur };
  }
  const plain = takeAll(st, PLAIN_RE);
  if (plain.length > 1) return { amountText: '', currency: null, question: `More than one number was found (${plain.map((m) => m[0].trim()).join(', ')}). Enter the amount to save.` };
  if (plain.length === 1) return { amountText: (plain[0][1] ? '-' : '') + plain[0][2].replace(/,/g, ''), currency: null, question: 'No currency was written next to the amount. Choose one.' };
  return { amountText: '', currency: null, question: 'No amount was found.' };
}

// ---------- title / category ----------
function titleFrom(rest: string): string {
  const strip = (t: string) => t.replace(/^[\s,:;\-–—]+|[\s,:;\-–—]+$/g, '');
  const tokens = rest.split(/\s+/).map(strip).filter(Boolean);
  const isStop = (t: string) => EDGE_STOPWORDS.has(t.normalize('NFC').toLowerCase());
  while (tokens.length && isStop(tokens[0])) tokens.shift();
  while (tokens.length && isStop(tokens[tokens.length - 1])) tokens.pop();
  const t = tokens.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function categoryFrom(title: string): { category: string | null; question?: string } {
  const hits = Object.entries(EXPENSE_CATEGORY_WORDS).filter(([, ws]) => rx(ws, true).test(title)).map(([c]) => c);
  if (hits.length === 1) return { category: hits[0] };
  if (hits.length > 1) return { category: null, question: `"${title}" could be ${hits.join(' or ')} - pick a category.` };
  return { category: null, question: 'Which category is this? I only fill it in when it is clear.' };
}

// ---------- main ----------
/**
 * Parse one pasted/typed command. Pure and local: `today` is the device's LOCAL calendar date
 * (YYYY-MM-DD) and all relative dates are computed from it. Anything missing or ambiguous is left
 * empty with a question. Amounts, currencies, dates and categories are never guessed.
 */
export function parseCommand(input: string, today: string): ParseResult {
  if (!isValidDateStr(today)) return { ok: false, error: 'Internal error: invalid current date.', original: input };
  if (!input.trim()) return { ok: false, error: 'Type or paste a command first.', original: input };
  if (input.length > MAX_COMMAND_LENGTH) return { ok: false, error: `That is too long (max ${MAX_COMMAND_LENGTH} characters).`, original: input };

  const text = normalizeInput(input);
  const isRem = rx(REMINDER_WORDS, true).test(text);
  const isExp = rx(EXPENSE_WORDS, true).test(text);
  const isTask = rx(TASK_WORDS, true).test(text);

  let kind: CommandKind | null = null;
  let candidates: CommandKind[] = [];
  const questions: CommandDraft['questions'] = {};
  if (isRem) candidates.push('reminder');
  else if (isTask) candidates.push('task');
  if (isExp) candidates.push('expense');

  if (!candidates.length) {
    if (!/\d/.test(text)) return { ok: false, error: `I didn't recognise that as an expense, task or reminder. ${SUPPORTED_HELP}`, original: input };
    candidates = ['expense', 'task'];
    questions.kind = 'There is a number but no action word. What should I create?';
  } else if (candidates.length === 1) kind = candidates[0];
  else questions.kind = 'This mentions both an expense and a task/reminder. What should I create?';

  const st: St = { rest: text };
  const timeOut = extractTime(st);
  const dateOut = extractDate(st, today);
  const wantsAmount = kind === 'expense' || kind === null;
  const amt: AmountOut = wantsAmount ? extractAmount(st) : { amountText: '', currency: null };

  takeAll(st, rxAll(REMINDER_WORDS, true));
  takeAll(st, rxAll(EXPENSE_WORDS, true));
  takeAll(st, rxAll(TASK_WORDS, true));
  takeAll(st, rxAll(FILLER_WORDS));
  const title = titleFrom(st.rest);

  const assumptions: string[] = [];
  let date = dateOut.date;
  if (dateOut.assumption) assumptions.push(dateOut.assumption);
  if (dateOut.bareKal) {
    if (kind === 'task' || kind === 'reminder') {
      date = addDays(today, 1);
      assumptions.push('"কাল / kal" means both yesterday and tomorrow in Bangla. I read it as tomorrow because tasks and reminders are for the future - change it if you meant otherwise.');
    } else questions.date = '"কাল / kal" can mean yesterday or tomorrow - pick the date.';
  }
  if (dateOut.question) questions.date = dateOut.question;
  if (timeOut.question) questions.time = timeOut.question;
  if (amt.question) { questions[amt.currency === null && amt.amountText ? 'currency' : 'amount'] = amt.question; }
  const cat = kind === 'expense' || kind === null ? categoryFrom(title) : { category: null as string | null };
  if (cat.question) questions.category = cat.question;
  if (!title) questions.title = kind === 'expense' ? undefined : 'What is the task or reminder about?';
  if (!date && !questions.date) questions.date = kind === 'reminder' ? 'When should I remind you?' : kind === 'task' ? undefined : 'What date? I only fill it in when it is stated.';

  return {
    ok: true,
    draft: {
      original: input, kind, candidates, title,
      amountText: amt.amountText, currency: amt.currency, date, time: timeOut.time,
      category: cat.category, priority: 'medium', assumptions, questions,
    },
  };
}
