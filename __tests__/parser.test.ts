import { checkDraft } from '../src/domain/parser/draft';
import { MAX_COMMAND_LENGTH, parseCommand, type CommandDraft } from '../src/domain/parser/parse';

const TODAY = '2026-10-10'; // a Saturday, local calendar date
const YESTERDAY = '2026-10-09';
const TOMORROW = '2026-10-11';

function parse(s: string): CommandDraft {
  const r = parseCommand(s, TODAY);
  if (!r.ok) throw new Error(`unexpected rejection: ${r.error}`);
  return r.draft;
}
const pick = (d: CommandDraft) => ({ kind: d.kind, title: d.title, amount: d.amountText, cur: d.currency, date: d.date, cat: d.category });

describe('supported English commands', () => {
  it.each([
    ['Add an expense of 250 taka for lunch today.', { kind: 'expense', title: 'Lunch', amount: '250', cur: 'BDT', date: TODAY, cat: 'Food' }],
    ['I spent 120 taka on transport yesterday.', { kind: 'expense', title: 'Transport', amount: '120', cur: 'BDT', date: YESTERDAY, cat: 'Transport' }],
    ['Remind me to pay the electricity bill tomorrow.', { kind: 'reminder', title: 'Pay the electricity bill', amount: '', cur: null, date: TOMORROW, cat: null }],
    ['Add a task to buy groceries.', { kind: 'task', title: 'Buy groceries', amount: '', cur: null, date: null, cat: null }],
  ])('%s', (input, want) => expect(pick(parse(input))).toEqual(want));
});

describe('supported Bangla commands', () => {
  it.each([
    ['আজ দুপুরের খাবারের জন্য ২৫০ টাকা খরচ যোগ করো।', { kind: 'expense', title: 'দুপুরের খাবারের', amount: '250', cur: 'BDT', date: TODAY, cat: 'Food' }],
    ['আগামীকাল বিদ্যুৎ বিল দেওয়ার কথা মনে করিয়ে দাও।', { kind: 'reminder', title: 'বিদ্যুৎ বিল দেওয়ার', amount: '', cur: null, date: TOMORROW, cat: null }],
    ['বাজার করার জন্য একটি কাজ যোগ করো।', { kind: 'task', title: 'বাজার করার', amount: '', cur: null, date: null, cat: null }],
    ['গতকাল যাতায়াতে ১২০ টাকা খরচ হয়েছে।', { kind: 'expense', title: 'যাতায়াতে', amount: '120', cur: 'BDT', date: YESTERDAY, cat: 'Transport' }],
  ])('%s', (input, want) => expect(pick(parse(input))).toEqual(want));
});

describe('supported Banglish commands', () => {
  it.each([
    ['Aj lunch er jonno 250 taka expense add koro.', { kind: 'expense', title: 'Lunch', amount: '250', cur: 'BDT', date: TODAY, cat: 'Food' }],
    ['Kal electricity bill dewar reminder dao.', { kind: 'reminder', title: 'Electricity bill dewar', amount: '', cur: null, date: TOMORROW, cat: null }],
    ['Bazar korar jonno ekta task add koro.', { kind: 'task', title: 'Bazar korar', amount: '', cur: null, date: null, cat: null }],
    ['Gotokal transport e 120 taka khoroch hoise.', { kind: 'expense', title: 'Transport', amount: '120', cur: 'BDT', date: YESTERDAY, cat: 'Transport' }],
  ])('%s', (input, want) => expect(pick(parse(input))).toEqual(want));
});

describe('all 12 documented examples are complete and pass domain validation', () => {
  it.each([
    'Add an expense of 250 taka for lunch today.', 'Remind me to pay the electricity bill tomorrow.', 'Add a task to buy groceries.', 'I spent 120 taka on transport yesterday.',
    'আজ দুপুরের খাবারের জন্য ২৫০ টাকা খরচ যোগ করো।', 'আগামীকাল বিদ্যুৎ বিল দেওয়ার কথা মনে করিয়ে দাও।', 'বাজার করার জন্য একটি কাজ যোগ করো।', 'গতকাল যাতায়াতে ১২০ টাকা খরচ হয়েছে।',
    'Aj lunch er jonno 250 taka expense add koro.', 'Kal electricity bill dewar reminder dao.', 'Bazar korar jonno ekta task add koro.', 'Gotokal transport e 120 taka khoroch hoise.',
  ])('%s', (s) => {
    const c = checkDraft(parse(s), TODAY);
    expect(c.issues).toEqual({});
    expect(c.action).not.toBeNull();
  });

  it('expense action carries exact minor units and the original text', () => {
    const d = parse('Add an expense of 250 taka for lunch today.');
    const a = checkDraft(d, TODAY).action!;
    expect(a).toEqual({ type: 'addExpense', value: { amountMinor: 25000, currency: 'BDT', category: 'Food', note: 'Lunch', date: TODAY, originalText: 'Add an expense of 250 taka for lunch today.' } });
  });
});

describe('original input is preserved byte-for-byte', () => {
  it('keeps casing, punctuation and Bangla text', () => {
    const s = '  আজ দুপুরের খাবারের জন্য ২৫০ টাকা খরচ যোগ করো।  ';
    expect(parse(s).original).toBe(s);
  });
});

describe('numbers', () => {
  it('normalises Bangla digits and decimals without float drift', () => {
    const d = parse('spent ১২৫০.৫০ taka on transport yesterday');
    expect(d.amountText).toBe('1250.50');
    expect(checkDraft(d, TODAY).action).toMatchObject({ value: { amountMinor: 125050 } });
  });
  it('accepts thousands separators and currency symbols', () => {
    expect(parse('I spent 1,250.50 taka on rent yesterday').amountText).toBe('1250.50');
    const d = parse('spent ৳250 on lunch today');
    expect([d.amountText, d.currency]).toEqual(['250', 'BDT']);
    expect(parse('spent $5 on coffee today').currency).toBe('USD');
  });
  it.each([['spent 0 taka on lunch today'], ['spent -50 taka on lunch today'], ['spent 2.555 taka on lunch today']])('blocks invalid amount: %s', (s) => {
    const c = checkDraft(parse(s), TODAY);
    expect(c.action).toBeNull();
    expect(c.issues.amount).toBeDefined();
  });
  it('does not pick between two amounts', () => {
    const d = parse('spent 250 taka and 100 taka on lunch today');
    expect(d.amountText).toBe('');
    expect(d.questions.amount).toMatch(/more than one amount/i);
    expect(checkDraft(d, TODAY).action).toBeNull();
  });
  it('does not treat the amount in a reminder as a transaction', () => {
    const d = parse('Remind me to pay 500 taka rent tomorrow');
    expect([d.kind, d.amountText, d.title]).toEqual(['reminder', '', 'Pay 500 taka rent']);
  });
});

describe('never invents missing financial details', () => {
  it('asks for the currency when none is written', () => {
    const d = parse('Add expense 250 for lunch today');
    expect(d.currency).toBeNull();
    const c = checkDraft(d, TODAY);
    expect(c.action).toBeNull();
    expect(c.issues.currency).toBeDefined();
  });

  it('rejects inherited currency names in an edited expense draft', () => {
    const parsed = parse('Add expense 250 for lunch today');
    const check = checkDraft({ ...parsed, currency: 'constructor' }, TODAY);
    expect(check.issues.currency).toMatch(/not supported/i);
    expect(check.action).toBeNull();
  });
  it('asks for the date when none is written (expense)', () => {
    const c = checkDraft(parse('I spent 120 taka on transport'), TODAY);
    expect(c.issues.date).toBeDefined();
    expect(c.action).toBeNull();
  });
  it('asks for a category when it is unclear or unknown', () => {
    expect(checkDraft(parse('I spent 120 taka on stuff yesterday'), TODAY).issues.category).toBeDefined();
    const bazar = parse('spent ৳250 on bazar yesterday');
    expect(bazar.category).toBeNull();
    expect(bazar.questions.category).toMatch(/Food or Shopping/);
  });
  it('asks for an amount when only a category is given', () => {
    expect(checkDraft(parse('I spent money on lunch yesterday'), TODAY).issues.amount).toBeDefined();
  });
});

describe('ambiguous dates', () => {
  it('bare "kal" in an expense is not guessed', () => {
    const d = parse('Kal lunch e 200 taka khoroch');
    expect(d.date).toBeNull();
    expect(d.questions.date).toMatch(/yesterday or tomorrow/);
    expect(checkDraft(d, TODAY).issues.date).toBeDefined();
  });
  it('bare "kal" in a reminder/task is read as tomorrow AND disclosed as an assumption', () => {
    const d = parse('কাল ডাক্তারের কাছে যাওয়ার কথা মনে করিয়ে দাও');
    expect(d.date).toBe(TOMORROW);
    expect(d.assumptions.join(' ')).toMatch(/tomorrow/);
  });
  it('পরশু / porshu is ambiguous in every case', () => {
    expect(parse('Remind me to call mom porshu').date).toBeNull();
    expect(parse('পরশু বাজার করার কাজ যোগ করো').date).toBeNull();
  });
  it('reads relative dates from the supplied local date', () => {
    expect(parse('Remind me to call mom in 3 days').date).toBe('2026-10-13');
    expect(parse('Remind me to call mom the day after tomorrow').date).toBe('2026-10-12');
    expect(parse('Remind me to call mom on 2026-12-25').date).toBe('2026-12-25');
  });
  it('weekday means the next occurrence after today and is disclosed', () => {
    const d = parse('Remind me to call mom next monday'); // today is Saturday
    expect(d.date).toBe('2026-10-12');
    expect(d.assumptions.length).toBe(1);
    expect(parse('Remind me to call mom on saturday').date).toBe('2026-10-17'); // not today
  });
  it('rejects impossible calendar dates', () => {
    const d = parse('Remind me to pay rent on 2026-02-30');
    expect(d.date).toBeNull();
    expect(d.questions.date).toMatch(/not a real calendar date/);
  });
  it('conflicting dates are not resolved silently', () => {
    expect(parse('Remind me to call mom today and tomorrow').date).toBeNull();
  });
  it('month rollover and leap day are handled by the shared date helpers', () => {
    const r = parseCommand('Remind me to call mom tomorrow', '2028-02-28');
    expect(r.ok && r.draft.date).toBe('2028-02-29');
    const r2 = parseCommand('Remind me to call mom tomorrow', '2026-12-31');
    expect(r2.ok && r2.draft.date).toBe('2027-01-01');
  });
});

describe('times', () => {
  it.each([
    ['Remind me to call mom tomorrow at 5pm', '17:00'], ['Remind me to call mom tomorrow at 5:30 pm', '17:30'],
    ['Remind me to call mom tomorrow at 12am', '00:00'], ['Remind me to call mom tomorrow 17:45', '17:45'],
    ['আগামীকাল বিকাল ৫টায় মাকে ফোন করার কথা মনে করিয়ে দাও', '17:00'],
    ['agamikal sokal 8 tay mayer sathe kotha bolar reminder dao', '08:00'],
  ])('%s -> %s', (s, t) => expect(parse(s).time).toBe(t));
  it('does not guess am/pm', () => {
    const d = parse('Remind me to call mom tomorrow at 5');
    expect(d.time).toBeNull();
    expect(d.questions.time).toMatch(/am or pm/);
  });
  it('does not guess the part of the day in Bangla', () => {
    expect(parse('আগামীকাল ৫টায় মাকে ফোন করার কথা মনে করিয়ে দাও').questions.time).toBeDefined();
  });
  it('a time does not get mistaken for an amount', () => {
    const d = parse('spent 250 taka on lunch today at 1pm');
    expect([d.amountText, d.time]).toEqual(['250', '13:00']);
  });
});

describe('intent resolution', () => {
  it('asks when a number has no action word', () => {
    const d = parse('250 taka lunch');
    expect(d.kind).toBeNull();
    expect(d.candidates).toEqual(['expense', 'task']);
    expect(checkDraft(d, TODAY).issues.kind).toBeDefined();
  });
  it('asks when expense and reminder are both mentioned', () => {
    const d = parse('Remind me that I spent 500 taka');
    expect(d.kind).toBeNull();
    expect(d.candidates).toEqual(['reminder', 'expense']);
  });
  it('a reminder needs a date; a plain task does not', () => {
    expect(checkDraft(parse('Remind me to call mom'), TODAY).issues.date).toBeDefined();
    expect(checkDraft(parse('Add a task to call mom'), TODAY).action).not.toBeNull();
  });
});

describe('rejects unsupported or malformed input safely', () => {
  it.each([[''], ['   '], ['hello world'], ['what is the weather like'], ['।।।']])('rejects %j', (s) => {
    expect(parseCommand(s, TODAY).ok).toBe(false);
  });
  it('rejects over-long input', () => {
    expect(parseCommand('spent 5 taka ' + 'x'.repeat(MAX_COMMAND_LENGTH), TODAY).ok).toBe(false);
  });
  it('rejects an invalid "today"', () => {
    expect(parseCommand('Add a task to buy milk', 'not-a-date').ok).toBe(false);
  });
  it('does not misread hostile or odd text as financial data', () => {
    const d = parse('Add a task to check 1e9 =SUM(A1) <script>alert(1)</script>');
    expect(d.kind).toBe('task');
    expect(d.amountText).toBe('');
  });
});

describe('checkDraft: edits drive validation', () => {
  it('becomes valid once the user supplies the missing fields', () => {
    const d = parse('Add expense 250 for lunch today');
    expect(checkDraft(d, TODAY).action).toBeNull();
    const edited = { ...d, currency: 'BDT' };
    expect(checkDraft(edited, TODAY).action).not.toBeNull();
  });
  it('blocks a future-dated expense and a past reminder', () => {
    const e = parse('I spent 120 taka on transport yesterday');
    expect(checkDraft({ ...e, date: TOMORROW }, TODAY).issues.date).toMatch(/future/);
    const r = parse('Remind me to call mom tomorrow');
    expect(checkDraft({ ...r, date: YESTERDAY }, TODAY).issues.date).toMatch(/past/);
  });
  it('re-validates edited values against the domain rules', () => {
    const e = parse('I spent 120 taka on transport yesterday');
    expect(checkDraft({ ...e, amountText: '12.345' }, TODAY).issues.amount).toBeDefined();
    expect(checkDraft({ ...e, category: 'Nonsense' }, TODAY).issues.category).toBeDefined();
    expect(checkDraft({ ...e, currency: 'XXX' }, TODAY).issues.currency).toBeDefined();
    const t = parse('Add a task to buy groceries');
    expect(checkDraft({ ...t, title: 'x'.repeat(201) }, TODAY).issues.title).toBeDefined();
    expect(checkDraft({ ...t, time: '25:99' }, TODAY).issues.time).toBeDefined();
    expect(checkDraft({ ...t, time: '10:00', date: null }, TODAY).issues.time).toBeDefined();
  });
  it('JPY has no minor units', () => {
    const e = parse('I spent 500 yen on transport yesterday');
    expect(checkDraft(e, TODAY).action).toMatchObject({ value: { amountMinor: 500, currency: 'JPY' } });
    expect(checkDraft({ ...e, amountText: '5.5' }, TODAY).action).toBeNull();
  });
});

describe('regressions found by probing', () => {
  it('a dropped optional date/time is surfaced, not silently lost', () => {
    const conflict = parse('Add task call mom tomorrow kal');
    expect(conflict.date).toBeNull();
    expect(checkDraft(conflict, TODAY).issues.date).toMatch(/more than one date/i);
    const bareHour = parse('Remind me to call mom tomorrow at 5');
    expect(checkDraft(bareHour, TODAY).issues.time).toMatch(/am or pm/);
    // once the user edits the field (UI clears its question) the draft is valid again
    expect(checkDraft({ ...conflict, questions: { ...conflict.questions, date: undefined } }, TODAY).action).not.toBeNull();
  });
  it('trims dangling connector words from titles', () => {
    expect(parse('Add a task: finish report by friday').title).toBe('Finish report');
    expect(parse('আমি আজ ২০০ টাকা খরচ করেছি খাবারে').title).toBe('খাবারে');
  });
  it('recognises bought/paid as expenses', () => {
    const d = parse('Bought 2 kg rice for 250 taka yesterday');
    expect([d.kind, d.amountText, d.currency, d.date]).toEqual(['expense', '250', 'BDT', YESTERDAY]);
  });
});
